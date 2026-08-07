/**
 * Shapes and constants shared by the SELECT loader and its UI.
 *
 * Kept separate from `products.server.ts` because Remix only strips server
 * code from a route's `loader`/`action`/`headers` exports — anything the
 * component itself reads has to live in a client-safe module.
 */

import type { ProductStatus } from "./filters";

/** Products per page in product view. */
export const PRODUCT_PAGE_SIZE = 50;

/** Products per page in variant view — each expands into several rows. */
export const VARIANT_VIEW_PAGE_SIZE = 25;

/**
 * Variants fetched per product. Caps query cost at roughly
 * `VARIANT_VIEW_PAGE_SIZE * (1 + VARIANTS_PER_PRODUCT)` nodes, comfortably
 * under Shopify's 1000-point ceiling. Products with more variants than this
 * show a "+N more" hint; APPLY re-resolves the full set from the filter, so
 * nothing is silently dropped from the actual edit.
 */
export const VARIANTS_PER_PRODUCT = 25;

export const SORT_OPTIONS = [
  { label: "Title", value: "TITLE" },
  { label: "Vendor", value: "VENDOR" },
  { label: "Product type", value: "PRODUCT_TYPE" },
  { label: "Inventory", value: "INVENTORY_TOTAL" },
  { label: "Last updated", value: "UPDATED_AT" },
  { label: "Date created", value: "CREATED_AT" },
] as const;

export type SortKey = (typeof SORT_OPTIONS)[number]["value"];

export function isSortKey(value: string): value is SortKey {
  return SORT_OPTIONS.some((option) => option.value === value);
}

export interface VariantRow {
  id: string;
  title: string;
  sku: string | null;
  price: string;
  compareAtPrice: string | null;
  inventoryQuantity: number | null;
}

export interface ProductRow {
  id: string;
  title: string;
  handle: string;
  vendor: string;
  productType: string;
  status: ProductStatus;
  tags: string[];
  totalInventory: number;
  variantCount: number;
  imageUrl: string | null;
  imageAlt: string | null;
  minPrice: string;
  maxPrice: string;
  currencyCode: string;
  /** Populated in variant view only, already narrowed to matching variants. */
  variants: VariantRow[];
  /** Variants that exist beyond `VARIANTS_PER_PRODUCT`. */
  moreVariants: number;
}

export interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

export interface ProductPage {
  products: ProductRow[];
  pageInfo: PageInfo;
  /** Products matching the filter across all pages. */
  totalProducts: number;
  /** True when Shopify returned a lower bound instead of an exact count. */
  totalIsLowerBound: boolean;
  /** Row-level ids on this page — products, or variants in variant view. */
  rowIds: string[];
  /** Matching variants on this page (variant view only). */
  variantsOnPage: number;
  /** The compiled Shopify search string, surfaced for debugging. */
  query: string;
}

export interface FacetOption {
  label: string;
  value: string;
}

export interface Facets {
  vendors: FacetOption[];
  productTypes: FacetOption[];
  tags: FacetOption[];
  collections: FacetOption[];
}
