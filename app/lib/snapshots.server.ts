/**
 * Building the before-picture.
 *
 * A `Snapshot` row is the undo. Everything else in Phase 4 is delivery; this is
 * the part that has to be right, and the invariant it exists to serve is in
 * `apply.server.ts`: not one mutation runs until every row here is committed.
 *
 * Two ways in:
 *
 *   APPLY re-resolves the merchant's selection server-side and reuses
 *   `buildPreview` — the identical arithmetic that produced the diff table they
 *   approved — so what gets snapshotted and what gets written cannot drift
 *   apart. It never trusts a row list posted by the browser.
 *
 *   UNDO reads the original job's applied rows, fetches what the catalog holds
 *   *now*, and inverts them. Reading the live value rather than assuming it
 *   still equals what we wrote is what lets undo be honest about a product
 *   somebody edited in between, and what lets an undo itself be undone.
 */

import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

import type { EditAction } from "./actions";
import type { SortKey } from "./catalog";
import { isSortKey } from "./catalog";
import type { SelectFilters } from "./filters";
import { parseFilters, serializeFilters } from "./filters";
import { encodeValue } from "./mutations";
import { buildPreview } from "./preview.server";
import type { PreviewResult } from "./preview.server";
import { ThrottledAdmin } from "./throttle.server";
import type { Selection } from "./use-selection";
import { coerceSelection } from "./use-selection";

/** A `Snapshot` row before it has an id or a job. */
export interface SnapshotDraft {
  ownerGid: string;
  productGid: string | null;
  fieldPath: string;
  oldValue: string;
  newValue: string;
  drifted: boolean;
  /**
   * Set when the row is known to be unappliable before the job even starts —
   * a product that has since been deleted. Pre-failing it is what keeps the
   * job from waiting forever on a row nothing will ever apply.
   */
  error: string | null;
}

/**
 * Everything needed to re-resolve a selection server-side. Persisted verbatim
 * as `EditJob.filterJson`, so a job can be re-run or inspected months later
 * without the browser that created it.
 */
export interface JobScope {
  filters: SelectFilters;
  selection: Selection;
  /** Rows the merchant unticked in the preview table. */
  excluded: string[];
  sortKey: SortKey;
  reverse: boolean;
}

export function parseScope(value: unknown): JobScope {
  const record = (value ?? {}) as Record<string, unknown>;
  const [rawKey, rawDirection] = String(record.sort ?? "TITLE asc").split(" ");
  return {
    filters: parseFilters(new URLSearchParams(String(record.filters ?? ""))),
    selection: coerceSelection(record.selection),
    excluded: Array.isArray(record.excluded)
      ? record.excluded.filter((id): id is string => typeof id === "string")
      : [],
    sortKey: isSortKey(rawKey) ? rawKey : "TITLE",
    reverse: rawDirection === "desc",
  };
}

export function serializeScope(scope: JobScope): Record<string, unknown> {
  return {
    filters: serializeFilters(scope.filters).toString(),
    selection: scope.selection,
    excluded: scope.excluded,
    sort: `${scope.sortKey} ${scope.reverse ? "desc" : "asc"}`,
  };
}

/**
 * Thrown when a scope cannot be snapshotted completely. Applying a partial
 * snapshot would produce an edit that undo could only partly reverse, so the
 * job fails instead — loudly, before anything is written.
 */
export class IncompleteScopeError extends Error {}

export interface ApplyDrafts {
  drafts: SnapshotDraft[];
  preview: PreviewResult;
}

export interface BuildApplyOptions {
  /**
   * Called as the scan pages through the catalog.
   *
   * APPLY passes its job heartbeat here. Resolving a large selection can run
   * for minutes, and a job that says nothing for that long is indistinguishable
   * from a crashed one to the stale sweep — which would then requeue an edit
   * that is proceeding perfectly well.
   */
  onProgress?: () => void | Promise<void>;
}

/**
 * The before-picture for an APPLY job.
 *
 * `rowLimit: Infinity` is the point of this function: the preview a merchant
 * looked at was capped at what a table can show, but the snapshot has to cover
 * every affected row or undo restores only the part that fit on screen.
 */
export async function buildApplyDrafts(
  admin: AdminApiContext,
  scope: JobScope,
  actions: EditAction[],
  { onProgress }: BuildApplyOptions = {},
): Promise<ApplyDrafts> {
  const preview = await buildPreview(admin, {
    filters: scope.filters,
    actions,
    selection: scope.selection,
    sortKey: scope.sortKey,
    reverse: scope.reverse,
    rowLimit: Number.POSITIVE_INFINITY,
    onProgress,
  });

  if (preview.truncated) {
    throw new IncompleteScopeError(
      "This selection is larger than one job can snapshot. Narrow the filter and apply it in parts.",
    );
  }
  if (preview.clippedProducts > 0) {
    throw new IncompleteScopeError(
      `${preview.clippedProducts} selected product(s) have more variants than this edit can read in one pass. Narrow the filter and apply it in parts.`,
    );
  }

  const excluded = new Set(scope.excluded);
  const drafts: SnapshotDraft[] = [];

  for (const row of preview.rows) {
    if (excluded.has(row.id)) continue;
    for (const diff of row.diffs) {
      drafts.push({
        ownerGid: row.id,
        productGid: row.productId,
        fieldPath: diff.fieldPath,
        oldValue: diff.rawBefore,
        newValue: diff.rawAfter,
        drifted: false,
        error: null,
      });
    }
  }

  return { drafts, preview };
}

// --- undo -------------------------------------------------------------------

/** A row of the job being undone. */
export interface AppliedSnapshot {
  ownerGid: string;
  productGid: string | null;
  fieldPath: string;
  oldValue: string;
  newValue: string;
}

const CURRENT_VALUES_QUERY = `#graphql
  query AmendCurrentValues($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on Product {
        id
        status
        tags
        title
        descriptionHtml
        vendor
        productType
        seo {
          title
          description
        }
      }
      ... on ProductVariant {
        id
        price
        compareAtPrice
        inventoryPolicy
        inventoryItem {
          tracked
        }
        product {
          id
        }
      }
    }
  }
`;

/** Owners read per request. Well inside the 250-node ceiling on `nodes`. */
const NODE_CHUNK = 100;

/**
 * Invert an applied job into the rows that put the catalog back.
 *
 * The new row's `newValue` is the original's `oldValue` — that is the restore.
 * Its `oldValue` is what the catalog holds *right now*, not what the original
 * job wrote, which is what makes an undo undoable in turn and what surfaces
 * drift: if the live value is no longer what we wrote, someone edited this
 * product in between and the merchant is told so. The undo still applies —
 * SPEC §5 — because a snapshot the merchant asked to restore is not ours to
 * second-guess.
 */
export async function buildUndoDrafts(
  admin: AdminApiContext,
  applied: AppliedSnapshot[],
): Promise<SnapshotDraft[]> {
  const live = await fetchCurrentValues(
    admin,
    [...new Set(applied.map((row) => row.ownerGid))],
  );

  return applied.map((row) => {
    const current = live.get(row.ownerGid);
    if (!current) {
      return {
        ownerGid: row.ownerGid,
        productGid: row.productGid,
        fieldPath: row.fieldPath,
        // Nothing to read, so the best record of the pre-undo state is what
        // this job wrote. The row is pre-failed, so it is never sent.
        oldValue: row.newValue,
        newValue: row.oldValue,
        drifted: true,
        error: "No longer exists in the catalog",
      };
    }

    const currentValue = encodeValue(
      current.values[row.fieldPath] ?? null,
    );
    return {
      ownerGid: row.ownerGid,
      productGid: current.productGid ?? row.productGid,
      fieldPath: row.fieldPath,
      oldValue: currentValue,
      newValue: row.oldValue,
      drifted: !sameEncoded(currentValue, row.newValue),
      error: null,
    };
  });
}

interface LiveOwner {
  productGid: string | null;
  values: Record<string, unknown>;
}

async function fetchCurrentValues(
  admin: AdminApiContext,
  ids: string[],
): Promise<Map<string, LiveOwner>> {
  const client = new ThrottledAdmin(admin);
  const found = new Map<string, LiveOwner>();

  for (let i = 0; i < ids.length; i += NODE_CHUNK) {
    const chunk = ids.slice(i, i + NODE_CHUNK);
    const data = await client.run<{ nodes: (LiveNode | null)[] }>(
      CURRENT_VALUES_QUERY,
      { ids: chunk },
    );

    for (const node of data.nodes) {
      if (!node) continue;
      // Keyed by `fieldPath`, so undoing a field is a lookup rather than a
      // branch — every field added to `actions.ts` needs its live reading here
      // and nowhere else.
      if (node.__typename === "Product") {
        found.set(node.id, {
          productGid: node.id,
          values: {
            "product.status": node.status,
            "product.tags": node.tags,
            "product.title": node.title,
            "product.descriptionHtml": node.descriptionHtml,
            "product.vendor": node.vendor,
            "product.productType": node.productType,
            "product.seo.title": node.seo?.title ?? null,
            "product.seo.description": node.seo?.description ?? null,
          },
        });
      } else if (node.__typename === "ProductVariant") {
        found.set(node.id, {
          productGid: node.product?.id ?? null,
          values: {
            "variant.price": node.price,
            "variant.compareAtPrice": node.compareAtPrice,
            "variant.inventoryPolicy": node.inventoryPolicy,
            "variant.inventoryItem.tracked":
              node.inventoryItem?.tracked ?? null,
          },
        });
      }
    }
  }

  return found;
}

interface LiveNode {
  __typename: string;
  id: string;
  status?: string;
  tags?: string[];
  title?: string;
  descriptionHtml?: string | null;
  vendor?: string;
  productType?: string;
  seo?: { title: string | null; description: string | null } | null;
  price?: string;
  compareAtPrice?: string | null;
  inventoryPolicy?: string;
  inventoryItem?: { tracked: boolean | null } | null;
  product?: { id: string } | null;
}

/**
 * "Is the live value still what this job wrote?" — asked the way Shopify
 * answers, not the way we sent it.
 *
 * Two normalisations, both learned the hard way rather than assumed:
 * money comes back "0.0" for a price written as "0.00", and tags come back
 * sorted regardless of the order they were written in. Comparing raw strings
 * would report drift on almost every undo and make the flag worthless.
 */
function sameEncoded(a: string, b: string): boolean {
  if (a === b) return true;

  let left: unknown;
  let right: unknown;
  try {
    left = JSON.parse(a);
    right = JSON.parse(b);
  } catch {
    return false;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    const sortedLeft = [...left].map(String).sort();
    const sortedRight = [...right].map(String).sort();
    return sortedLeft.every((value, i) => value === sortedRight[i]);
  }

  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (
    left !== null &&
    right !== null &&
    Number.isFinite(leftNumber) &&
    Number.isFinite(rightNumber)
  ) {
    return leftNumber === rightNumber;
  }

  return false;
}

// --- labels -----------------------------------------------------------------

const ROW_LABELS_QUERY = `#graphql
  query AmendRowLabels($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on Product {
        id
        title
      }
      ... on ProductVariant {
        id
        title
        product {
          id
          title
        }
      }
    }
  }
`;

export interface OwnerLabel {
  title: string;
  /** Variant name, for a row that is a variant of the product above. */
  detail: string | null;
}

/**
 * Product and variant names for a page of snapshot rows.
 *
 * Snapshots store GIDs, because a title copied at edit time would be a second
 * source of truth that goes stale. The job page pays one small query to show
 * the merchant names instead of `gid://shopify/ProductVariant/12345`, and rows
 * whose product has since been deleted simply keep the GID.
 */
export async function fetchOwnerLabels(
  admin: AdminApiContext,
  ids: string[],
): Promise<Map<string, OwnerLabel>> {
  const labels = new Map<string, OwnerLabel>();
  if (!ids.length) return labels;

  const client = new ThrottledAdmin(admin);
  const unique = [...new Set(ids)];

  for (let i = 0; i < unique.length; i += NODE_CHUNK) {
    const data = await client.run<{ nodes: (LabelNode | null)[] }>(
      ROW_LABELS_QUERY,
      { ids: unique.slice(i, i + NODE_CHUNK) },
    );
    for (const node of data.nodes) {
      if (!node) continue;
      labels.set(
        node.id,
        node.__typename === "ProductVariant"
          ? { title: node.product?.title ?? node.title, detail: node.title }
          : { title: node.title, detail: null },
      );
    }
  }

  return labels;
}

interface LabelNode {
  __typename: string;
  id: string;
  title: string;
  product?: { id: string; title: string } | null;
}
