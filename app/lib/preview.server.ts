/**
 * Turns a selection plus a stack of actions into the diff table the merchant
 * approves before anything is written.
 *
 * The whole point of this module is that it is read-only. Phase 4 will take the
 * same `PreviewRow[]`, persist it as `Snapshot` rows, and only then mutate — so
 * a bug here shows up as a wrong preview, never as a wrong catalog.
 *
 * Diff arithmetic itself lives in `actions.ts` and never touches the network,
 * which is what lets `scripts/verify-filters.ts` assert real diffs against seed
 * data whose values are known from the seed's PRNG.
 */

import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

import type { DiffProduct, EditAction, PreviewRow } from "./actions";
import {
  actionsNeedContent,
  actionsNeedInventory,
  actionsTouchVariants,
  isActionComplete,
  previewRowsForProduct,
} from "./actions";
import type { SortKey } from "./catalog";
import { PREVIEW_PRODUCT_CAP, PREVIEW_ROW_LIMIT } from "./catalog";
import type { SelectFilters } from "./filters";
import { variantMatchesFilters } from "./filters";
import type { ProductNode } from "./products.server";
import { collectMatchingProducts } from "./products.server";
import type { Selection } from "./use-selection";

/**
 * Products per request when variants come along. The cost rule multiplies
 * nested connections, so 25 products x 25 variants stays well inside Shopify's
 * 1,000-point ceiling where 250 would blow straight through it.
 */
const PREVIEW_PAGE_WITH_VARIANTS = 25;

/**
 * Products per request when variants also carry their inventory settings.
 *
 * `inventoryItem` is a nested object, so it roughly doubles what each variant
 * costs — 25 x 25 with it would land past the 1,000-point ceiling and every
 * page of the scan would be rejected outright.
 */
const PREVIEW_PAGE_WITH_INVENTORY = 10;

export interface BuildPreviewArgs {
  filters: SelectFilters;
  actions: EditAction[];
  selection: Selection;
  sortKey: SortKey;
  reverse: boolean;
  /**
   * Changed rows to return. Defaults to `PREVIEW_ROW_LIMIT`, which is what the
   * browser can usefully render. APPLY passes `Infinity`: a snapshot has to
   * cover every affected row or undo would restore only part of the catalog,
   * and a truncated row list is exactly how that bug would happen.
   */
  rowLimit?: number;
  /**
   * Called as the product scan pages. Preview itself has no use for it — this
   * exists so APPLY, which runs the same scan across a whole catalog inside a
   * claimed job slot, can keep its heartbeat current while it waits.
   */
  onProgress?: () => void | Promise<void>;
}

export interface PreviewResult {
  rows: PreviewRow[];
  /** Distinct products with at least one change. */
  productsChanged: number;
  /** Distinct variants with at least one change. */
  variantsChanged: number;
  /** Selected products the actions turned out to leave alone. */
  productsUnchanged: number;
  /** True when the product scan hit `PREVIEW_PRODUCT_CAP`. */
  truncated: boolean;
  /** True when there are more changed rows than `PREVIEW_ROW_LIMIT` shows. */
  rowsTruncated: boolean;
  /** Changed rows that exist, including any beyond `PREVIEW_ROW_LIMIT`. */
  totalRows: number;
  /**
   * Selected products with more variants than one query returns. Their extra
   * variants are absent from this preview, so the UI has to say so rather than
   * imply the diff is complete.
   */
  clippedProducts: number;
}

export const EMPTY_PREVIEW: PreviewResult = {
  rows: [],
  productsChanged: 0,
  variantsChanged: 0,
  productsUnchanged: 0,
  truncated: false,
  rowsTruncated: false,
  totalRows: 0,
  clippedProducts: 0,
};

export async function buildPreview(
  admin: AdminApiContext,
  {
    filters,
    actions,
    selection,
    sortKey,
    reverse,
    rowLimit = PREVIEW_ROW_LIMIT,
    onProgress,
  }: BuildPreviewArgs,
): Promise<PreviewResult> {
  const live = actions.filter(isActionComplete);
  if (!live.length) return EMPTY_PREVIEW;

  const variantView = filters.view === "variant";
  // Variants are needed to price them, and in variant view they are also what
  // the merchant selected — so we need them to honour the selection at all.
  const includeVariants = variantView || actionsTouchVariants(live);
  const includeInventory = actionsNeedInventory(live);

  const { products, truncated } = await collectMatchingProducts(admin, {
    filters,
    sortKey,
    reverse,
    includeVariants,
    includeContent: actionsNeedContent(live),
    includeInventory,
    cap: PREVIEW_PRODUCT_CAP,
    pageSize: includeInventory
      ? PREVIEW_PAGE_WITH_INVENTORY
      : includeVariants
        ? PREVIEW_PAGE_WITH_VARIANTS
        : undefined,
    onPage: onProgress,
  });

  const rows: PreviewRow[] = [];
  const changedProducts = new Set<string>();
  let variantsChanged = 0;
  let productsUnchanged = 0;
  let totalRows = 0;
  let clippedProducts = 0;

  for (const node of products) {
    const scope = selectionScope(node, filters, selection, variantView);
    if (!scope.selected) continue;

    if (includeVariants && variantsWereClipped(node)) clippedProducts += 1;

    const produced = previewRowsForProduct(
      toDiffProduct(node),
      live,
      scope.variantIds,
    );

    if (!produced.length) {
      productsUnchanged += 1;
      continue;
    }

    changedProducts.add(node.id);
    for (const row of produced) {
      if (row.kind === "variant") variantsChanged += 1;
      totalRows += 1;
      if (rows.length < rowLimit) rows.push(row);
    }
  }

  return {
    rows,
    productsChanged: changedProducts.size,
    variantsChanged,
    productsUnchanged,
    truncated,
    rowsTruncated: totalRows > rows.length,
    totalRows,
    clippedProducts,
  };
}

interface Scope {
  selected: boolean;
  /** Variant GIDs in scope, or null for "the whole product". */
  variantIds: Set<string> | null;
}

const OUT_OF_SCOPE: Scope = { selected: false, variantIds: null };

/**
 * How much of one product the merchant actually picked.
 *
 * In product view a row is a product and an edit covers all of its variants. In
 * variant view a row is a variant, so a price edit has to stay on the variants
 * that were ticked — spilling onto a selected variant's siblings is exactly the
 * kind of silent over-reach this app exists to avoid.
 */
function selectionScope(
  node: ProductNode,
  filters: SelectFilters,
  selection: Selection,
  variantView: boolean,
): Scope {
  if (!variantView) {
    const picked =
      selection.mode === "all"
        ? !selection.excluded.includes(node.id)
        : selection.ids.includes(node.id);
    return picked ? { selected: true, variantIds: null } : OUT_OF_SCOPE;
  }

  // Variant view: only variants that both match the filter and were ticked.
  const matching = (node.variants?.nodes ?? []).filter((variant) =>
    variantMatchesFilters(variant, filters),
  );
  const chosen = matching.filter((variant) =>
    selection.mode === "all"
      ? !selection.excluded.includes(variant.id)
      : selection.ids.includes(variant.id),
  );
  if (!chosen.length) return OUT_OF_SCOPE;

  return {
    selected: true,
    variantIds: new Set(chosen.map((variant) => variant.id)),
  };
}

/**
 * Variants are narrowed by the caller's scope set, not here — filtering twice
 * would drop a variant the merchant explicitly ticked.
 */
function toDiffProduct(node: ProductNode): DiffProduct {
  return {
    id: node.id,
    title: node.title,
    handle: node.handle,
    status: node.status,
    tags: node.tags,
    vendor: node.vendor,
    productType: node.productType,
    // `undefined` where the scan didn't fetch the field, `null` where the
    // product genuinely has no value. `actions.ts` diffs the second and skips
    // the first, so the two must not be collapsed here.
    descriptionHtml: node.descriptionHtml,
    seoTitle: node.seo?.title,
    seoDescription: node.seo?.description,
    variants: (node.variants?.nodes ?? []).map((variant) => ({
      id: variant.id,
      title: variant.title,
      sku: variant.sku,
      price: variant.price,
      compareAtPrice: variant.compareAtPrice,
      inventoryPolicy: variant.inventoryPolicy,
      tracked:
        variant.inventoryItem === undefined
          ? undefined
          : (variant.inventoryItem?.tracked ?? null),
    })),
  };
}

/** True when a product has more variants than one page query brings back. */
function variantsWereClipped(node: ProductNode): boolean {
  const fetched = node.variants?.nodes.length ?? 0;
  const total = node.variantsCount?.count ?? fetched;
  return total > fetched;
}
