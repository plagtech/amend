/**
 * The EDIT half of the app: the actions a merchant stacks onto a selection, and
 * the pure functions that turn them into before → after diffs.
 *
 * Isomorphic on purpose, same as `filters.ts` — the route renders the builder
 * from these types and the loader/action computes diffs with the same code, so
 * the preview a merchant approves is produced by the identical arithmetic that
 * Phase 4 will persist and apply.
 *
 * Nothing here talks to Shopify. Everything is `(current value, action) =>
 * next value`, which is what makes the preview trustworthy and testable: a
 * diff can be checked against known seed data without touching the network.
 *
 * A `PreviewDiff` is deliberately shaped like a `Snapshot` row (`ownerGid`,
 * `fieldPath`, before, after) — Phase 4 persists these verbatim as the undo
 * record rather than recomputing them.
 */

import type { ProductStatus } from "./filters";
import { PRODUCT_STATUSES } from "./filters";

// --- the action model -------------------------------------------------------

export type PriceField = "price" | "compareAtPrice";
export type PriceOp = "set" | "increase" | "decrease";
export type PriceUnit = "percent" | "fixed";

/** Psychological price endings. `none` keeps whatever the arithmetic produced. */
export type Rounding = "none" | "end99" | "end95" | "end00";

export interface PriceAction {
  type: "price";
  field: PriceField;
  op: PriceOp;
  unit: PriceUnit;
  /** Kept as a string so a half-typed "1." round-trips without becoming NaN. */
  amount: string;
  rounding: Rounding;
}

export interface TagsAction {
  type: "tags";
  op: "add" | "remove" | "replace";
  tags: string[];
}

export interface StatusAction {
  type: "status";
  value: ProductStatus;
}

export type EditAction = PriceAction | TagsAction | StatusAction;
export type ActionType = EditAction["type"];

export const ACTION_TYPES: { type: ActionType; label: string }[] = [
  { type: "price", label: "Price" },
  { type: "tags", label: "Tags" },
  { type: "status", label: "Status" },
];

export function newAction(type: ActionType): EditAction {
  switch (type) {
    case "price":
      return {
        type: "price",
        field: "price",
        op: "decrease",
        unit: "percent",
        amount: "",
        rounding: "none",
      };
    case "tags":
      return { type: "tags", op: "add", tags: [] };
    case "status":
      return { type: "status", value: "ACTIVE" };
  }
}

/**
 * True when an action is filled in enough to compute a diff. A half-built
 * action is not an error — it just doesn't contribute to the preview yet, so
 * the builder can stay open while the merchant types.
 */
export function isActionComplete(action: EditAction): boolean {
  switch (action.type) {
    case "price":
      return parseAmount(action.amount) !== null;
    case "tags":
      // "replace" with an empty list is meaningful: it clears every tag.
      return action.op === "replace" || action.tags.length > 0;
    case "status":
      return true;
  }
}

/** Only variant-scoped actions need variants fetched to preview them. */
export function actionsTouchVariants(actions: EditAction[]): boolean {
  return actions.some((action) => action.type === "price");
}

export function actionsTouchProducts(actions: EditAction[]): boolean {
  return actions.some(
    (action) => action.type === "tags" || action.type === "status",
  );
}

// --- serialization ----------------------------------------------------------

/**
 * Actions round-trip as one JSON blob rather than as flat search params: they
 * are an ordered, heterogeneous list, and this is the exact shape that lands in
 * `EditJob.actionsJson`. Unknown or malformed entries are dropped rather than
 * thrown on, so a hand-edited URL degrades to "fewer actions" instead of a
 * broken page.
 */
export function parseActions(raw: string | null | undefined): EditAction[] {
  if (!raw) return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(decoded)) return [];
  return decoded.flatMap((entry) => {
    const action = coerceAction(entry);
    return action ? [action] : [];
  });
}

export function serializeActions(actions: EditAction[]): string {
  return JSON.stringify(actions);
}

function coerceAction(entry: unknown): EditAction | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;

  if (record.type === "price") {
    const field: PriceField =
      record.field === "compareAtPrice" ? "compareAtPrice" : "price";
    const op: PriceOp =
      record.op === "set" || record.op === "increase" ? record.op : "decrease";
    const unit: PriceUnit = record.unit === "fixed" ? "fixed" : "percent";
    const rounding = ROUNDINGS.includes(record.rounding as Rounding)
      ? (record.rounding as Rounding)
      : "none";
    return {
      type: "price",
      field,
      op,
      unit,
      amount: typeof record.amount === "string" ? record.amount : "",
      rounding,
    };
  }

  if (record.type === "tags") {
    const op =
      record.op === "remove" || record.op === "replace" ? record.op : "add";
    const tags = Array.isArray(record.tags)
      ? record.tags.filter((tag): tag is string => typeof tag === "string")
      : [];
    return { type: "tags", op, tags };
  }

  if (record.type === "status") {
    const value = (PRODUCT_STATUSES as readonly string[]).includes(
      record.value as string,
    )
      ? (record.value as ProductStatus)
      : "ACTIVE";
    return { type: "status", value };
  }

  return null;
}

const ROUNDINGS: Rounding[] = ["none", "end99", "end95", "end00"];

/** Identity of an action set — used to drop a stale preview when it changes. */
export function actionsSignature(actions: EditAction[]): string {
  return serializeActions(actions.filter(isActionComplete));
}

// --- money ------------------------------------------------------------------

/**
 * Prices are computed in integer cents throughout. Doing percentage maths in
 * floats and rounding at the end drifts — 19.99 * 0.85 is 16.9915 in binary
 * floating point, and a bulk editor that is a cent out across 3,000 variants
 * is a support ticket per merchant.
 */
function toCents(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100);
}

function fromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

function parseAmount(amount: string): number | null {
  if (amount.trim() === "") return null;
  const parsed = Number.parseFloat(amount);
  return Number.isFinite(parsed) ? parsed : null;
}

function applyRounding(cents: number, rounding: Rounding): number {
  switch (rounding) {
    case "none":
      return cents;
    // Keep the dollar part, force the cents. Applied after the arithmetic, so
    // "decrease 15% then round to .99" reads the way a merchant says it.
    case "end99":
      return Math.floor(cents / 100) * 100 + 99;
    case "end95":
      return Math.floor(cents / 100) * 100 + 95;
    case "end00":
      return Math.round(cents / 100) * 100;
  }
}

/**
 * The new value for one money field, or null to leave it alone.
 *
 * Returns null when there is nothing to compute from: an increase or decrease
 * needs a current value, so a variant with no compare-at price is skipped
 * rather than invented. `set` always applies — that is how a merchant puts a
 * compare-at price on for the first time.
 */
export function nextPrice(
  current: string | null,
  action: PriceAction,
): string | null {
  const amount = parseAmount(action.amount);
  if (amount === null) return null;

  if (action.op === "set") {
    const target = toCents(action.amount);
    if (target === null) return null;
    return fromCents(Math.max(0, applyRounding(target, action.rounding)));
  }

  const currentCents = toCents(current);
  if (currentCents === null) return null;

  const sign = action.op === "increase" ? 1 : -1;
  const raw =
    action.unit === "percent"
      ? Math.round(currentCents * (1 + (sign * amount) / 100))
      : currentCents + sign * Math.round(amount * 100);

  // A bulk edit must never produce a negative price; Shopify would reject the
  // mutation anyway, and the merchant should see the floor in the preview.
  return fromCents(Math.max(0, applyRounding(Math.max(0, raw), action.rounding)));
}

// --- tags -------------------------------------------------------------------

/** Tag matching is case-insensitive, but the merchant's casing is what sticks. */
export function nextTags(current: string[], action: TagsAction): string[] {
  const clean = action.tags.map((tag) => tag.trim()).filter(Boolean);

  switch (action.op) {
    case "add": {
      const seen = new Set(current.map((tag) => tag.toLowerCase()));
      const added = clean.filter((tag) => !seen.has(tag.toLowerCase()));
      return [...current, ...added];
    }
    case "remove": {
      const drop = new Set(clean.map((tag) => tag.toLowerCase()));
      return current.filter((tag) => !drop.has(tag.toLowerCase()));
    }
    case "replace":
      return clean;
  }
}

// --- diffs ------------------------------------------------------------------

export interface PreviewDiff {
  /** Matches `Snapshot.fieldPath` — e.g. "variant.price", "product.tags". */
  fieldPath: string;
  label: string;
  /** Human-readable, for the diff table. Lossy on purpose (null renders "—"). */
  before: string;
  after: string;
  /**
   * The same two values JSON-encoded, losslessly. This is what `Snapshot`
   * persists and what the mutation builder decodes and sends, so the numbers a
   * merchant approved in the preview are the exact bytes that reach Shopify —
   * a tag containing ", " or an absent compare-at price survives the round trip
   * where the display strings above would not.
   */
  rawBefore: string;
  rawAfter: string;
}

export interface PreviewRow {
  /** Owner GID: the exclude key here, and `Snapshot.ownerGid` in Phase 4. */
  id: string;
  kind: "product" | "variant";
  productId: string;
  productTitle: string;
  /** Variant rows only. */
  variantTitle: string | null;
  sku: string | null;
  diffs: PreviewDiff[];
}

export interface DiffProduct {
  id: string;
  title: string;
  status: ProductStatus;
  tags: string[];
  variants: DiffVariant[];
}

export interface DiffVariant {
  id: string;
  title: string;
  sku: string | null;
  price: string;
  compareAtPrice: string | null;
}

const PRICE_LABEL: Record<PriceField, string> = {
  price: "Price",
  compareAtPrice: "Compare at price",
};

/**
 * Product-level diffs for one product. Returns an empty list when the actions
 * leave it untouched — setting status to ACTIVE on an already-active product is
 * not a change, and showing it as one would inflate every count in the summary.
 */
export function productDiffs(
  product: DiffProduct,
  actions: EditAction[],
): PreviewDiff[] {
  let tags = product.tags;
  let status = product.status;

  for (const action of actions) {
    if (!isActionComplete(action)) continue;
    if (action.type === "tags") tags = nextTags(tags, action);
    if (action.type === "status") status = action.value;
  }

  const diffs: PreviewDiff[] = [];
  if (!sameTags(product.tags, tags)) {
    diffs.push({
      fieldPath: "product.tags",
      label: "Tags",
      before: product.tags.join(", ") || "—",
      after: tags.join(", ") || "—",
      rawBefore: JSON.stringify(product.tags),
      rawAfter: JSON.stringify(tags),
    });
  }
  if (status !== product.status) {
    diffs.push({
      fieldPath: "product.status",
      label: "Status",
      before: product.status,
      after: status,
      rawBefore: JSON.stringify(product.status),
      rawAfter: JSON.stringify(status),
    });
  }
  return diffs;
}

export function variantDiffs(
  variant: DiffVariant,
  actions: EditAction[],
): PreviewDiff[] {
  let price = variant.price;
  let compareAt = variant.compareAtPrice;

  for (const action of actions) {
    if (action.type !== "price" || !isActionComplete(action)) continue;
    if (action.field === "price") {
      price = nextPrice(price, action) ?? price;
    } else {
      compareAt = nextPrice(compareAt, action) ?? compareAt;
    }
  }

  const diffs: PreviewDiff[] = [];
  if (!sameMoney(variant.price, price)) {
    diffs.push({
      fieldPath: "variant.price",
      label: PRICE_LABEL.price,
      before: variant.price,
      after: price,
      rawBefore: JSON.stringify(variant.price),
      rawAfter: JSON.stringify(price),
    });
  }
  if (!sameMoney(variant.compareAtPrice, compareAt)) {
    diffs.push({
      fieldPath: "variant.compareAtPrice",
      label: PRICE_LABEL.compareAtPrice,
      before: variant.compareAtPrice ?? "—",
      after: compareAt ?? "—",
      rawBefore: JSON.stringify(variant.compareAtPrice),
      rawAfter: JSON.stringify(compareAt),
    });
  }
  return diffs;
}

/**
 * Every changed row for one product: the product itself when tags or status
 * move, plus one row per variant whose money changed.
 *
 * `variantScope` is the set of variant GIDs the merchant actually selected — in
 * variant view a price edit must not spill onto the siblings of a selected
 * variant. `null` means the whole product is in scope.
 */
export function previewRowsForProduct(
  product: DiffProduct,
  actions: EditAction[],
  variantScope: Set<string> | null,
): PreviewRow[] {
  const rows: PreviewRow[] = [];

  const onProduct = productDiffs(product, actions);
  if (onProduct.length) {
    rows.push({
      id: product.id,
      kind: "product",
      productId: product.id,
      productTitle: product.title,
      variantTitle: null,
      sku: null,
      diffs: onProduct,
    });
  }

  for (const variant of product.variants) {
    if (variantScope && !variantScope.has(variant.id)) continue;
    const diffs = variantDiffs(variant, actions);
    if (!diffs.length) continue;
    rows.push({
      id: variant.id,
      kind: "variant",
      productId: product.id,
      productTitle: product.title,
      variantTitle: variant.title,
      sku: variant.sku,
      diffs,
    });
  }

  return rows;
}

function sameTags(before: string[], after: string[]): boolean {
  return before.length === after.length && before.every((tag, i) => tag === after[i]);
}

function sameMoney(before: string | null, after: string | null): boolean {
  const a = toCents(before);
  const b = toCents(after);
  return a === b;
}
