/**
 * The EDIT half of the app: the actions a merchant stacks onto a selection, and
 * the pure functions that turn them into before → after diffs.
 *
 * Isomorphic on purpose, same as `filters.ts` — the route renders the builder
 * from these types and the loader/action computes diffs with the same code, so
 * the preview a merchant approves is produced by the identical arithmetic that
 * Phase 4 persists and applies.
 *
 * Nothing here talks to Shopify. Everything is `(current value, action) =>
 * next value`, which is what makes the preview trustworthy and testable: a
 * diff can be checked against known seed data without touching the network.
 *
 * A `PreviewDiff` is deliberately shaped like a `Snapshot` row (`ownerGid`,
 * `fieldPath`, before, after) — Phase 4 persists these verbatim as the undo
 * record rather than recomputing them.
 *
 * ## Adding a field (Phase 5 and after)
 *
 * Every action type in this file is the same three things: a case in
 * `nextProduct`/`nextVariant` that computes the next value, an entry in the
 * field tables below that turns a changed value into a `PreviewDiff`, and a
 * `fieldPath` the mutation builder knows how to address. Nothing in the engine
 * changed to add title, description, SEO, inventory, vendor or type — a new
 * field is a new row in a table here plus the field on the read query.
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

/**
 * A find & replace, shared by the text action and the tag action because they
 * mean exactly the same thing — the only difference is whether it runs over one
 * string or over each tag in turn.
 *
 * `regex` is SPEC §3's "advanced" mode. A pattern that doesn't compile is
 * treated as "matches nothing" rather than thrown on: a merchant halfway
 * through typing `(` must get an empty preview, not a broken page.
 */
export interface TextMatch {
  find: string;
  replaceWith: string;
  caseSensitive: boolean;
  regex: boolean;
}

export function emptyMatch(): TextMatch {
  return { find: "", replaceWith: "", caseSensitive: false, regex: false };
}

export interface TagsAction {
  type: "tags";
  op: "add" | "remove" | "replace" | "findReplace";
  tags: string[];
  /** `findReplace` only; ignored by the other ops. */
  match: TextMatch;
}

export interface StatusAction {
  type: "status";
  value: ProductStatus;
}

/**
 * Product text fields, all edited the same four ways.
 *
 * Vendor and product type are here rather than in an action of their own
 * because "set vendor to X" is `op: "set"` on this action — and having them
 * here means find & replace works on them too, which is free and is what a
 * merchant renaming a vendor across 400 products actually wants.
 */
export type TextTarget =
  | "title"
  | "description"
  | "seoTitle"
  | "seoDescription"
  | "vendor"
  | "productType";

export type TextOp = "replace" | "append" | "prepend" | "set";

export interface TextAction {
  type: "text";
  field: TextTarget;
  op: TextOp;
  /** `replace` only. */
  match: TextMatch;
  /** `append` / `prepend` / `set`. Supports `{{title}}`-style tokens. */
  value: string;
}

/**
 * The two inventory settings SPEC §3 asks for: whether Shopify tracks the
 * quantity, and whether it keeps selling at zero.
 *
 * Deliberately not quantity adjustment. A quantity is a moving number owned by
 * fulfilment, and an undo that restores yesterday's count over today's sales
 * would be worse than no undo at all — the one thing this app promises is that
 * reversing an edit is safe.
 */
export type InventoryField = "tracked" | "policy";

export interface InventoryAction {
  type: "inventory";
  field: InventoryField;
  /** tracked: is quantity tracked. policy: keep selling when out of stock. */
  value: boolean;
}

/**
 * SKU and barcode: the variant-level text fields.
 *
 * Separate from `TextAction` because they are a different scope — these are
 * written by `productVariantsBulkUpdate` and everything in `TextAction` by
 * `productUpdate` — and because they take no `{{token}}`s. A token expands from
 * the product, and a SKU templated identically across a product's variants
 * would be a worse answer than the one the merchant meant.
 *
 * `clear` is offered for the barcode only. Shopify collapses an empty barcode
 * to null (probed on 2026-07: writing `""` reads back as `null`), so clearing
 * has to record null as the new value or the snapshot would describe a state the
 * catalog is not in and every undo would report drift.
 */
export type VariantTextTarget = "sku" | "barcode";
export type VariantTextOp = "replace" | "set" | "clear";

export interface VariantTextAction {
  type: "variantText";
  field: VariantTextTarget;
  op: VariantTextOp;
  /** `replace` only. */
  match: TextMatch;
  /** `set` only. */
  value: string;
}

export const WEIGHT_UNITS = [
  "KILOGRAMS",
  "GRAMS",
  "POUNDS",
  "OUNCES",
] as const;
export type WeightUnit = (typeof WEIGHT_UNITS)[number];

/** A variant's shipping weight. Both halves or neither — never one. */
export interface Weight {
  value: number;
  unit: WeightUnit;
}

/**
 * Weight is one logical value, so it is one action, one diff column and one
 * snapshot row holding `{value, unit}` together. Splitting it would let an undo
 * restore 500 with the unit already back to pounds.
 *
 * `convert` changes the unit and carries the value across exactly; `set` writes
 * both. No percentage or relative arithmetic — a bulk editor that quietly
 * reweighs a catalog by 10% is not a feature anyone asked for.
 */
export interface WeightAction {
  type: "weight";
  op: "set" | "convert";
  /** `set` only. Kept as a string so a half-typed "1." survives. */
  value: string;
  unit: WeightUnit;
}

export type EditAction =
  | PriceAction
  | TagsAction
  | StatusAction
  | TextAction
  | InventoryAction
  | VariantTextAction
  | WeightAction;

export type ActionType = EditAction["type"];

/**
 * The "Add action" menu.
 *
 * Keyed separately from `EditAction["type"]` because three menu entries create
 * the same kind of action pointed at different fields — a merchant looking for
 * SEO should not have to know that it is the same machinery as the title.
 */
export type ActionMenuKey =
  | "price"
  | "tags"
  | "status"
  | "content"
  | "seo"
  | "organization"
  | "inventory"
  | "identifiers"
  | "weight";

export const ACTION_TYPES: { key: ActionMenuKey; label: string }[] = [
  { key: "price", label: "Price" },
  { key: "tags", label: "Tags" },
  { key: "status", label: "Status" },
  { key: "content", label: "Title & description" },
  { key: "seo", label: "SEO" },
  { key: "organization", label: "Vendor & type" },
  { key: "inventory", label: "Inventory" },
  { key: "identifiers", label: "SKU & barcode" },
  { key: "weight", label: "Weight" },
];

export function newAction(key: ActionMenuKey): EditAction {
  switch (key) {
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
      return { type: "tags", op: "add", tags: [], match: emptyMatch() };
    case "status":
      return { type: "status", value: "ACTIVE" };
    case "content":
      return {
        type: "text",
        field: "title",
        op: "replace",
        match: emptyMatch(),
        value: "",
      };
    case "seo":
      return {
        type: "text",
        field: "seoTitle",
        op: "set",
        match: emptyMatch(),
        value: "",
      };
    case "organization":
      return {
        type: "text",
        field: "vendor",
        op: "set",
        match: emptyMatch(),
        value: "",
      };
    case "inventory":
      return { type: "inventory", field: "policy", value: true };
    case "identifiers":
      return {
        type: "variantText",
        field: "sku",
        op: "replace",
        match: emptyMatch(),
        value: "",
      };
    case "weight":
      return { type: "weight", op: "set", value: "", unit: "KILOGRAMS" };
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
      if (action.op === "findReplace") return action.match.find !== "";
      // "replace" with an empty list is meaningful: it clears every tag.
      return action.op === "replace" || action.tags.length > 0;
    case "status":
      return true;
    case "text":
      if (action.op === "replace") return action.match.find !== "";
      // An empty `set` on an optional field is a real instruction — that is how
      // an SEO override or a description gets cleared. An empty `set` on the
      // title is not: it would blank the product name, and no merchant means
      // that by leaving a box empty.
      return action.value !== "" || (action.op === "set" && CLEARABLE.has(action.field));
    case "inventory":
      return true;
    case "variantText":
      if (action.op === "replace") return action.match.find !== "";
      // `clear` needs nothing typed; `set` needs something to set.
      return action.op === "clear" || action.value !== "";
    case "weight":
      return action.op === "convert" || parseWeight(action.value) !== null;
  }
}

/** A weight the merchant typed. Negative is not a weight; zero is (unset). */
function parseWeight(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Text fields where "set to nothing" means "clear it", not "unfinished". */
const CLEARABLE = new Set<TextTarget>([
  "description",
  "seoTitle",
  "seoDescription",
]);

/** Only variant-scoped actions need variants fetched to preview them. */
export function actionsTouchVariants(actions: EditAction[]): boolean {
  return actions.some(
    (action) =>
      action.type === "price" ||
      action.type === "inventory" ||
      action.type === "variantText" ||
      action.type === "weight",
  );
}

/** True when any action rewrites SKUs — the duplicate check is only worth it then. */
export function actionsTouchSku(actions: EditAction[]): boolean {
  return actions.some(
    (action) => action.type === "variantText" && action.field === "sku",
  );
}

export function actionsTouchProducts(actions: EditAction[]): boolean {
  return actions.some(
    (action) =>
      action.type === "tags" ||
      action.type === "status" ||
      action.type === "text",
  );
}

/**
 * Whether the product scan has to pay for the expensive content fields.
 *
 * Title, vendor and product type are on every product read anyway; description
 * and SEO are not, and description in particular is the largest field on the
 * record. Fetching them only when an action touches them keeps a plain price
 * edit as cheap as it was before Phase 5.
 */
export function actionsNeedContent(actions: EditAction[]): boolean {
  return actions.some(
    (action) =>
      action.type === "text" &&
      (action.field === "description" ||
        action.field === "seoTitle" ||
        action.field === "seoDescription"),
  );
}

/**
 * Whether variants have to carry their `inventoryItem`.
 *
 * It is a nested object — two, once `measurement` comes with it — so asking for
 * it multiplies the query cost of every variant on every page. See
 * `PREVIEW_PAGE_WITH_INVENTORY`.
 *
 * SKU and barcode are deliberately not in this list: both are plain scalars on
 * the variant itself, so they are always read and cost nothing. Only the write
 * side of a SKU goes through `inventoryItem` (`ProductVariantsBulkInput` has no
 * `sku` field of its own — probed on 2026-07).
 */
export function actionsNeedInventory(actions: EditAction[]): boolean {
  return actions.some(
    (action) => action.type === "inventory" || action.type === "weight",
  );
}

// --- serialization ----------------------------------------------------------

/**
 * Actions round-trip as one JSON blob rather than as flat search params: they
 * are an ordered, heterogeneous list, and this is the exact shape that lands in
 * `EditJob.actionsJson` and `SavedTemplate.actionsJson`. Unknown or malformed
 * entries are dropped rather than thrown on, so a hand-edited URL — or a
 * template saved by an older version — degrades to "fewer actions" instead of a
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
      record.op === "remove" ||
      record.op === "replace" ||
      record.op === "findReplace"
        ? record.op
        : "add";
    const tags = Array.isArray(record.tags)
      ? record.tags.filter((tag): tag is string => typeof tag === "string")
      : [];
    return { type: "tags", op, tags, match: coerceMatch(record.match) };
  }

  if (record.type === "status") {
    const value = (PRODUCT_STATUSES as readonly string[]).includes(
      record.value as string,
    )
      ? (record.value as ProductStatus)
      : "ACTIVE";
    return { type: "status", value };
  }

  if (record.type === "text") {
    const field = TEXT_TARGETS.includes(record.field as TextTarget)
      ? (record.field as TextTarget)
      : "title";
    const op = TEXT_OPS.includes(record.op as TextOp)
      ? (record.op as TextOp)
      : "replace";
    return {
      type: "text",
      field,
      op,
      match: coerceMatch(record.match),
      value: typeof record.value === "string" ? record.value : "",
    };
  }

  if (record.type === "inventory") {
    return {
      type: "inventory",
      field: record.field === "tracked" ? "tracked" : "policy",
      value: record.value !== false,
    };
  }

  if (record.type === "variantText") {
    const op = VARIANT_TEXT_OPS.includes(record.op as VariantTextOp)
      ? (record.op as VariantTextOp)
      : "replace";
    const field: VariantTextTarget =
      record.field === "barcode" ? "barcode" : "sku";
    return {
      type: "variantText",
      field,
      // Only the barcode can be cleared; a `clear` aimed at a SKU degrades to
      // the harmless op rather than blanking every SKU in the selection.
      op: op === "clear" && field !== "barcode" ? "replace" : op,
      match: coerceMatch(record.match),
      value: typeof record.value === "string" ? record.value : "",
    };
  }

  if (record.type === "weight") {
    return {
      type: "weight",
      op: record.op === "convert" ? "convert" : "set",
      value: typeof record.value === "string" ? record.value : "",
      unit: (WEIGHT_UNITS as readonly string[]).includes(record.unit as string)
        ? (record.unit as WeightUnit)
        : "KILOGRAMS",
    };
  }

  return null;
}

function coerceMatch(value: unknown): TextMatch {
  const record = (value ?? {}) as Record<string, unknown>;
  return {
    find: typeof record.find === "string" ? record.find : "",
    replaceWith:
      typeof record.replaceWith === "string" ? record.replaceWith : "",
    caseSensitive: record.caseSensitive === true,
    regex: record.regex === true,
  };
}

const ROUNDINGS: Rounding[] = ["none", "end99", "end95", "end00"];

const TEXT_TARGETS: TextTarget[] = [
  "title",
  "description",
  "seoTitle",
  "seoDescription",
  "vendor",
  "productType",
];

const TEXT_OPS: TextOp[] = ["replace", "append", "prepend", "set"];

const VARIANT_TEXT_OPS: VariantTextOp[] = ["replace", "set", "clear"];

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

// --- text -------------------------------------------------------------------

/**
 * What `{{title}}`-style tokens resolve to (SPEC §3, SEO templating).
 *
 * Read from the *running* values rather than the original ones, so an action
 * stack that renames a product and then templates its SEO title off `{{title}}`
 * uses the new name. That is the order the merchant wrote them in.
 */
export interface TokenContext {
  title: string;
  vendor: string;
  productType: string;
  handle: string;
  tags: string[];
}

const TOKEN_PATTERN = /\{\{\s*([a-zA-Z]+)\s*\}\}/g;

/**
 * Expand tokens in a template.
 *
 * An unknown token is left standing rather than blanked. A merchant who typed
 * `{{titel}}` sees `{{titel}}` in the preview and fixes it; blanking it would
 * silently write a truncated SEO title across their catalog.
 */
export function expandTokens(template: string, tokens: TokenContext): string {
  return template.replace(TOKEN_PATTERN, (whole, name: string) => {
    switch (name.toLowerCase()) {
      case "title":
        return tokens.title;
      case "vendor":
        return tokens.vendor;
      case "type":
      case "producttype":
        return tokens.productType;
      case "handle":
        return tokens.handle;
      case "tags":
        return tokens.tags.join(", ");
      default:
        return whole;
    }
  });
}

export const TOKEN_HELP = "{{title}} · {{vendor}} · {{type}} · {{handle}} · {{tags}}";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a match, or null if it cannot be compiled.
 *
 * Always global: "find and replace" means every occurrence, which is what
 * competitors' "add text to the end" cannot do and what SPEC §1 calls out as a
 * wedge. Case-insensitive by default, per SPEC §3.
 */
function compileMatch(match: TextMatch): RegExp | null {
  if (!match.find) return null;
  try {
    return new RegExp(
      match.regex ? match.find : escapeRegExp(match.find),
      match.caseSensitive ? "g" : "gi",
    );
  } catch {
    // An unfinished or invalid pattern matches nothing. Throwing here would
    // take down a preview the merchant is still typing into.
    return null;
  }
}

/**
 * One find & replace over one string.
 *
 * In plain mode the replacement is escaped, so a merchant replacing something
 * with "$5" gets "$5" and not JavaScript's `$5` capture-group substitution. In
 * regex mode it is not escaped — `$1` there is the point.
 */
export function replaceIn(current: string, match: TextMatch): string {
  const pattern = compileMatch(match);
  if (!pattern) return current;
  const replacement = match.regex
    ? match.replaceWith
    : match.replaceWith.replace(/\$/g, "$$$$");
  return current.replace(pattern, replacement);
}

/** The new value for one text field. */
export function nextText(
  current: string,
  action: TextAction,
  tokens: TokenContext,
): string {
  switch (action.op) {
    case "replace":
      return replaceIn(current, {
        ...action.match,
        replaceWith: expandTokens(action.match.replaceWith, tokens),
      });
    case "append":
      return current + expandTokens(action.value, tokens);
    case "prepend":
      return expandTokens(action.value, tokens) + current;
    case "set":
      return expandTokens(action.value, tokens);
  }
}

// --- weight -----------------------------------------------------------------

/** Grams per unit. Exact figures — the pound is defined as 0.45359237 kg. */
const GRAMS_PER_UNIT: Record<WeightUnit, number> = {
  KILOGRAMS: 1000,
  GRAMS: 1,
  POUNDS: 453.59237,
  OUNCES: 28.349523125,
};

export const WEIGHT_UNIT_LABEL: Record<WeightUnit, string> = {
  KILOGRAMS: "kg",
  GRAMS: "g",
  POUNDS: "lb",
  OUNCES: "oz",
};

/**
 * Decimal places kept when converting.
 *
 * Enough that kg↔g and lb↔oz stay exact, and that a conversion round-trips
 * closely enough not to show as a change when nothing was meant to change.
 * Shopify stores a float, so this is our precision, not theirs.
 */
const WEIGHT_PRECISION = 4;

export function convertWeight(weight: Weight, unit: WeightUnit): Weight {
  if (weight.unit === unit) return weight;
  const grams = weight.value * GRAMS_PER_UNIT[weight.unit];
  const converted = grams / GRAMS_PER_UNIT[unit];
  const factor = 10 ** WEIGHT_PRECISION;
  return { value: Math.round(converted * factor) / factor, unit };
}

/**
 * The new weight, or null to leave it alone.
 *
 * A variant with no weight at all is left alone by `convert` — there is nothing
 * to carry across — and `set` gives it one, which is the only way to put a
 * weight on a variant that has none.
 */
export function nextWeight(
  current: Weight | null,
  action: WeightAction,
): Weight | null {
  if (action.op === "set") {
    const value = parseWeight(action.value);
    return value === null ? null : { value, unit: action.unit };
  }
  return current ? convertWeight(current, action.unit) : null;
}

export function sameWeight(a: Weight | null, b: Weight | null): boolean {
  if (a === null || b === null) return a === b;
  return a.unit === b.unit && a.value === b.value;
}

/** "1.2 kg". Trailing zeros trimmed — "500 g", not "500.0000 g". */
export function formatWeight(weight: Weight | null | undefined): string {
  if (!weight) return "—";
  return `${Number(weight.value.toFixed(WEIGHT_PRECISION))} ${
    WEIGHT_UNIT_LABEL[weight.unit] ?? weight.unit
  }`;
}

/** Narrow a value read from Shopify or decoded from a snapshot. */
export function coerceWeight(value: unknown): Weight | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const amount = Number(record.value);
  if (!Number.isFinite(amount)) return null;
  return (WEIGHT_UNITS as readonly string[]).includes(record.unit as string)
    ? { value: amount, unit: record.unit as WeightUnit }
    : null;
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
    case "findReplace": {
      // Two tags can collapse into one, and a tag can be replaced with nothing.
      // Shopify would silently dedupe the first and reject nothing for the
      // second, so both are resolved here — otherwise the snapshot would record
      // a tag list the catalog never actually held, and undo would restore it.
      const seen = new Set<string>();
      const next: string[] = [];
      for (const tag of current) {
        const replaced = replaceIn(tag, action.match).trim();
        if (!replaced) continue;
        const key = replaced.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(replaced);
      }
      return next;
    }
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

/**
 * What the preview reads off a product.
 *
 * `undefined` on an optional field means "the scan did not fetch this", which
 * is different from `null` ("the product has no SEO title"). The difference
 * matters: a diff computed against a field we never read would record a false
 * before-value, and undo would restore it. Anything `undefined` is skipped.
 */
export interface DiffProduct {
  id: string;
  title: string;
  handle: string;
  status: ProductStatus;
  tags: string[];
  vendor: string;
  productType: string;
  descriptionHtml?: string | null;
  seoTitle?: string | null;
  seoDescription?: string | null;
  variants: DiffVariant[];
}

export interface DiffVariant {
  id: string;
  title: string;
  sku: string | null;
  price: string;
  compareAtPrice: string | null;
  /** Always read — a plain scalar on the variant, so it costs nothing. */
  barcode?: string | null;
  /** "CONTINUE" | "DENY". Absent unless the scan asked for inventory. */
  inventoryPolicy?: string | null;
  tracked?: boolean | null;
  /** Absent unless the scan asked for inventory; null when the variant has none. */
  weight?: Weight | null;
}

/** The mutable half of a product — what an action stack produces. */
export type ProductState = Pick<
  DiffProduct,
  | "title"
  | "status"
  | "tags"
  | "vendor"
  | "productType"
  | "descriptionHtml"
  | "seoTitle"
  | "seoDescription"
>;

export type VariantState = Pick<
  DiffVariant,
  | "sku"
  | "price"
  | "compareAtPrice"
  | "barcode"
  | "inventoryPolicy"
  | "tracked"
  | "weight"
>;

const PRICE_LABEL: Record<PriceField, string> = {
  price: "Price",
  compareAtPrice: "Compare at price",
};

/**
 * Product text fields, in the order they appear in a diff row.
 *
 * One table drives three things — which action targets which field, which
 * `fieldPath` the snapshot records, and what the merchant sees — so a field can
 * never be renamed in one place and not the others.
 */
const PRODUCT_TEXT_FIELDS: {
  key: keyof ProductState;
  fieldPath: string;
  label: string;
}[] = [
  { key: "title", fieldPath: "product.title", label: "Title" },
  {
    key: "descriptionHtml",
    fieldPath: "product.descriptionHtml",
    label: "Description",
  },
  { key: "vendor", fieldPath: "product.vendor", label: "Vendor" },
  {
    key: "productType",
    fieldPath: "product.productType",
    label: "Product type",
  },
  { key: "seoTitle", fieldPath: "product.seo.title", label: "SEO title" },
  {
    key: "seoDescription",
    fieldPath: "product.seo.description",
    label: "SEO description",
  },
];

/** Where a `TextTarget` lives on a `ProductState`. */
const TARGET_KEY: Record<TextTarget, keyof ProductState> = {
  title: "title",
  description: "descriptionHtml",
  seoTitle: "seoTitle",
  seoDescription: "seoDescription",
  vendor: "vendor",
  productType: "productType",
};

/** Fields where an empty string and "not set" are the same thing to Shopify. */
const NULL_WHEN_EMPTY = new Set<keyof ProductState>([
  "seoTitle",
  "seoDescription",
]);

/**
 * Run an action stack over one product. Pure, and the single source of what an
 * edit means — `productDiffs` only compares this against what came in, and
 * `scripts/verify-apply.ts` uses it to predict the catalog it then reads back.
 */
export function nextProduct(
  product: DiffProduct,
  actions: EditAction[],
): ProductState {
  const state: ProductState = {
    title: product.title,
    status: product.status,
    tags: product.tags,
    vendor: product.vendor,
    productType: product.productType,
    descriptionHtml: product.descriptionHtml,
    seoTitle: product.seoTitle,
    seoDescription: product.seoDescription,
  };

  for (const action of actions) {
    if (!isActionComplete(action)) continue;
    if (action.type === "tags") state.tags = nextTags(state.tags, action);
    if (action.type === "status") state.status = action.value;
    if (action.type === "text") applyText(state, action, product.handle);
  }

  return state;
}

function applyText(
  state: ProductState,
  action: TextAction,
  handle: string,
): void {
  const key = TARGET_KEY[action.field];
  const current = state[key];
  // The scan didn't fetch this field, so there is no before-value to edit from.
  // Skipping is the safe direction: a missing diff writes nothing.
  if (current === undefined) return;
  if (typeof current !== "string" && current !== null) return;

  const next = nextText(current ?? "", action, {
    title: state.title,
    vendor: state.vendor,
    productType: state.productType,
    handle,
    tags: state.tags,
  });

  (state[key] as string | null) =
    next === "" && NULL_WHEN_EMPTY.has(key) ? null : next;
}

/**
 * Product-level diffs for one product. Returns an empty list when the actions
 * leave it untouched — setting status to ACTIVE on an already-active product is
 * not a change, and showing it as one would inflate every count in the summary.
 */
export function productDiffs(
  product: DiffProduct,
  actions: EditAction[],
): PreviewDiff[] {
  const next = nextProduct(product, actions);
  const diffs: PreviewDiff[] = [];

  if (!sameTags(product.tags, next.tags)) {
    diffs.push({
      fieldPath: "product.tags",
      label: "Tags",
      before: product.tags.join(", ") || "—",
      after: next.tags.join(", ") || "—",
      rawBefore: JSON.stringify(product.tags),
      rawAfter: JSON.stringify(next.tags),
    });
  }
  if (next.status !== product.status) {
    diffs.push({
      fieldPath: "product.status",
      label: "Status",
      before: product.status,
      after: next.status,
      rawBefore: JSON.stringify(product.status),
      rawAfter: JSON.stringify(next.status),
    });
  }

  for (const field of PRODUCT_TEXT_FIELDS) {
    const before = product[field.key as keyof DiffProduct] as
      | string
      | null
      | undefined;
    const after = next[field.key] as string | null | undefined;
    if (before === undefined || after === undefined) continue;
    if ((before ?? null) === (after ?? null)) continue;
    diffs.push({
      fieldPath: field.fieldPath,
      label: field.label,
      before: display(before),
      after: display(after),
      rawBefore: JSON.stringify(before ?? null),
      rawAfter: JSON.stringify(after ?? null),
    });
  }

  return diffs;
}

export function nextVariant(
  variant: DiffVariant,
  actions: EditAction[],
): VariantState {
  const state: VariantState = {
    sku: variant.sku,
    price: variant.price,
    compareAtPrice: variant.compareAtPrice,
    barcode: variant.barcode,
    inventoryPolicy: variant.inventoryPolicy,
    tracked: variant.tracked,
    weight: variant.weight,
  };

  for (const action of actions) {
    if (!isActionComplete(action)) continue;

    if (action.type === "variantText") {
      applyVariantText(state, action);
      continue;
    }

    if (action.type === "weight") {
      // Undo has no way back from "no weight": Shopify ignores
      // `measurement: { weight: null }` outright (probed on 2026-07), so a
      // variant that has none is left alone rather than given one we could not
      // take away again.
      if (state.weight === undefined || state.weight === null) continue;
      state.weight = nextWeight(state.weight, action) ?? state.weight;
      continue;
    }

    if (action.type === "price") {
      if (action.field === "price") {
        state.price = nextPrice(state.price, action) ?? state.price;
      } else {
        state.compareAtPrice =
          nextPrice(state.compareAtPrice, action) ?? state.compareAtPrice;
      }
      continue;
    }

    // As with text fields: a setting the scan didn't read has no before-value,
    // so it is left alone rather than guessed at.
    if (action.type === "inventory") {
      if (action.field === "policy") {
        if (state.inventoryPolicy === undefined) continue;
        state.inventoryPolicy = action.value ? "CONTINUE" : "DENY";
      } else {
        if (state.tracked === undefined || state.tracked === null) continue;
        state.tracked = action.value;
      }
    }
  }

  return state;
}

/**
 * SKU and barcode both collapse an empty string to null in Shopify (probed on
 * 2026-07), so the transform records null and the preview promises exactly what
 * the catalog will end up holding.
 */
function applyVariantText(
  state: VariantState,
  action: VariantTextAction,
): void {
  const current = state[action.field];
  if (current === undefined) return;

  let next: string;
  switch (action.op) {
    case "replace":
      next = replaceIn(current ?? "", action.match);
      break;
    case "set":
      next = action.value;
      break;
    case "clear":
      next = "";
      break;
  }

  // Trimmed, because Shopify trims: a SKU stored here with a trailing space
  // would come back without one and every undo would report drift that isn't.
  const trimmed = next.trim();
  state[action.field] = trimmed === "" ? null : trimmed;
}

export function variantDiffs(
  variant: DiffVariant,
  actions: EditAction[],
): PreviewDiff[] {
  const next = nextVariant(variant, actions);
  const diffs: PreviewDiff[] = [];

  if (!sameMoney(variant.price, next.price)) {
    diffs.push({
      fieldPath: "variant.price",
      label: PRICE_LABEL.price,
      before: variant.price,
      after: next.price,
      rawBefore: JSON.stringify(variant.price),
      rawAfter: JSON.stringify(next.price),
    });
  }
  if (!sameMoney(variant.compareAtPrice, next.compareAtPrice)) {
    diffs.push({
      fieldPath: "variant.compareAtPrice",
      label: PRICE_LABEL.compareAtPrice,
      before: variant.compareAtPrice ?? "—",
      after: next.compareAtPrice ?? "—",
      rawBefore: JSON.stringify(variant.compareAtPrice),
      rawAfter: JSON.stringify(next.compareAtPrice),
    });
  }
  if (
    variant.inventoryPolicy !== undefined &&
    next.inventoryPolicy !== undefined &&
    variant.inventoryPolicy !== next.inventoryPolicy
  ) {
    diffs.push({
      fieldPath: "variant.inventoryPolicy",
      label: "When out of stock",
      before: policyLabel(variant.inventoryPolicy),
      after: policyLabel(next.inventoryPolicy),
      rawBefore: JSON.stringify(variant.inventoryPolicy),
      rawAfter: JSON.stringify(next.inventoryPolicy),
    });
  }
  if (
    typeof variant.tracked === "boolean" &&
    typeof next.tracked === "boolean" &&
    variant.tracked !== next.tracked
  ) {
    diffs.push({
      fieldPath: "variant.inventoryItem.tracked",
      label: "Track quantity",
      before: variant.tracked ? "Yes" : "No",
      after: next.tracked ? "Yes" : "No",
      rawBefore: JSON.stringify(variant.tracked),
      rawAfter: JSON.stringify(next.tracked),
    });
  }
  // The SKU is written through `inventoryItem`, not the variant input — the
  // read is on the variant and the write is one level down.
  if ((variant.sku ?? null) !== (next.sku ?? null)) {
    diffs.push({
      fieldPath: "variant.inventoryItem.sku",
      label: "SKU",
      before: display(variant.sku ?? null),
      after: display(next.sku ?? null),
      rawBefore: JSON.stringify(variant.sku ?? null),
      rawAfter: JSON.stringify(next.sku ?? null),
    });
  }
  if (
    variant.barcode !== undefined &&
    next.barcode !== undefined &&
    (variant.barcode ?? null) !== (next.barcode ?? null)
  ) {
    diffs.push({
      fieldPath: "variant.barcode",
      label: "Barcode",
      before: display(variant.barcode ?? null),
      after: display(next.barcode ?? null),
      rawBefore: JSON.stringify(variant.barcode ?? null),
      rawAfter: JSON.stringify(next.barcode ?? null),
    });
  }
  // One row for both halves. A snapshot that stored the value and the unit
  // separately could restore 500 with the unit already back to pounds.
  if (
    variant.weight !== undefined &&
    next.weight !== undefined &&
    !sameWeight(variant.weight ?? null, next.weight ?? null)
  ) {
    diffs.push({
      fieldPath: "variant.inventoryItem.measurement.weight",
      label: "Weight",
      before: formatWeight(variant.weight),
      after: formatWeight(next.weight),
      rawBefore: JSON.stringify(variant.weight ?? null),
      rawAfter: JSON.stringify(next.weight ?? null),
    });
  }

  return diffs;
}

/**
 * The SKU every in-scope variant of one product would end up with.
 *
 * Shopify allows duplicate SKUs and will not complain, so if a find & replace
 * collapses two of them into one, nothing but this will notice. Used by the
 * preview to warn — never to block: duplicates are legal, and a merchant who
 * means it is entitled to them.
 */
export function scopedSkus(
  product: DiffProduct,
  actions: EditAction[],
  variantScope: Set<string> | null,
): string[] {
  const skus: string[] = [];
  for (const variant of product.variants) {
    if (variantScope && !variantScope.has(variant.id)) continue;
    const sku = nextVariant(variant, actions).sku;
    if (sku) skus.push(sku);
  }
  return skus;
}

/**
 * Every changed row for one product: the product itself when a product-level
 * field moves, plus one row per variant whose variant-level fields moved.
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

/** Diff-table rendering of a text value. Long HTML is clipped, never the raw. */
function display(value: string | null): string {
  if (value === null || value === "") return "—";
  return value.length > DISPLAY_LIMIT
    ? `${value.slice(0, DISPLAY_LIMIT)}…`
    : value;
}

const DISPLAY_LIMIT = 160;

function policyLabel(policy: string | null | undefined): string {
  if (policy === "CONTINUE") return "Continue selling";
  if (policy === "DENY") return "Stop selling";
  return policy ?? "—";
}

function sameTags(before: string[], after: string[]): boolean {
  return before.length === after.length && before.every((tag, i) => tag === after[i]);
}

function sameMoney(before: string | null, after: string | null): boolean {
  const a = toCents(before);
  const b = toCents(after);
  return a === b;
}
