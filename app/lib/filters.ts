/**
 * The SELECT half of the app: the filter criteria a merchant picks, how they
 * round-trip through the URL, and how they compile to Shopify search syntax.
 *
 * This module is isomorphic on purpose — the loader uses it to build the
 * GraphQL `query:` argument, and the route component uses it to render the
 * filter pills. A job's `filterJson` (Prisma `EditJob.filterJson`) is exactly
 * a serialized `SelectFilters`, so Phase 3+ can re-resolve a selection from
 * the filter alone rather than from a frozen list of IDs.
 *
 * Search syntax reference:
 * https://shopify.dev/docs/api/usage/search-syntax
 */

export const PRODUCT_STATUSES = ["ACTIVE", "DRAFT", "ARCHIVED"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export type SelectView = "product" | "variant";

export interface SelectFilters {
  /** Product rows, or variant rows grouped under their product. */
  view: SelectView;
  /** Free text, passed to Shopify's default multi-field product search. */
  search: string;
  /** Collection GID, or "" for no collection filter. */
  collectionId: string;
  vendors: string[];
  productTypes: string[];
  tags: string[];
  statuses: ProductStatus[];
  /** Kept as strings so blank/partial form input round-trips cleanly. */
  priceMin: string;
  priceMax: string;
  skuPrefix: string;
  inventoryMin: string;
  inventoryMax: string;
}

export function emptyFilters(): SelectFilters {
  return {
    view: "product",
    search: "",
    collectionId: "",
    vendors: [],
    productTypes: [],
    tags: [],
    statuses: [],
    priceMin: "",
    priceMax: "",
    skuPrefix: "",
    inventoryMin: "",
    inventoryMax: "",
  };
}

// --- URL round-tripping -----------------------------------------------------

const MULTI_KEYS = ["vendors", "productTypes", "tags", "statuses"] as const;

export function parseFilters(params: URLSearchParams): SelectFilters {
  const one = (key: string) => (params.get(key) ?? "").trim();
  const many = (key: string) =>
    params
      .getAll(key)
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean);

  const statuses = many("statuses").filter((value): value is ProductStatus =>
    (PRODUCT_STATUSES as readonly string[]).includes(value),
  );

  return {
    view: one("view") === "variant" ? "variant" : "product",
    search: one("search"),
    collectionId: one("collectionId"),
    vendors: many("vendors"),
    productTypes: many("productTypes"),
    tags: many("tags"),
    statuses,
    priceMin: numeric(one("priceMin")),
    priceMax: numeric(one("priceMax")),
    skuPrefix: one("skuPrefix"),
    inventoryMin: numeric(one("inventoryMin")),
    inventoryMax: numeric(one("inventoryMax")),
  };
}

/** Search params for a filter set. Empty values are dropped so URLs stay short. */
export function serializeFilters(filters: SelectFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.view !== "product") params.set("view", filters.view);
  if (filters.search) params.set("search", filters.search);
  if (filters.collectionId) params.set("collectionId", filters.collectionId);
  for (const key of MULTI_KEYS) {
    const values = filters[key];
    if (values.length) params.set(key, values.join(","));
  }
  for (const key of [
    "priceMin",
    "priceMax",
    "skuPrefix",
    "inventoryMin",
    "inventoryMax",
  ] as const) {
    if (filters[key]) params.set(key, filters[key]);
  }
  return params;
}

/**
 * Identity of a result set. Pagination cursors are deliberately excluded and
 * `view` deliberately included: when this changes the row IDs change too, so
 * the page drops any selection rather than carrying stale IDs forward.
 */
export function filterSignature(filters: SelectFilters): string {
  return serializeFilters(filters).toString();
}

export function activeFilterCount(filters: SelectFilters): number {
  const empty = emptyFilters();
  return (Object.keys(empty) as (keyof SelectFilters)[]).filter((key) => {
    if (key === "view") return false;
    const value = filters[key];
    return Array.isArray(value) ? value.length > 0 : value !== "";
  }).length;
}

// --- Shopify search syntax --------------------------------------------------

/**
 * Single-quoted search literal. Shopify treats a quoted value as an exact
 * phrase, which is what we want for vendors/types/tags that contain spaces.
 */
function quote(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * Shopify supports a trailing `*` for prefix matching but has no leading
 * wildcard, and wildcards don't work inside quotes. So a value that needs
 * quoting falls back to an exact match.
 */
function prefix(field: string, value: string): string {
  return /^[\w.\-/]+$/.test(value)
    ? `${field}:${value}*`
    : `${field}:${quote(value)}`;
}

function anyOf(field: string, values: string[]): string | null {
  if (!values.length) return null;
  const terms = values.map((value) => `${field}:${quote(value)}`);
  return terms.length === 1 ? terms[0] : `(${terms.join(" OR ")})`;
}

function range(field: string, min: string, max: string): string[] {
  const clauses: string[] = [];
  if (min !== "") clauses.push(`${field}:>=${min}`);
  if (max !== "") clauses.push(`${field}:<=${max}`);
  return clauses;
}

/** Numeric legacy ID from a GID — Shopify's search syntax takes the bare ID. */
export function legacyId(gid: string): string {
  return gid.split("/").pop() ?? gid;
}

/**
 * Compile filters into the `query:` argument of the `products` connection.
 *
 * Both views run through this one query. In variant view the loader expands
 * each matching product's variants and narrows them further with
 * `variantMatchesFilters` — see the note there for why.
 */
export function buildProductQuery(filters: SelectFilters): string {
  const clauses: (string | null)[] = [];

  if (filters.search) clauses.push(quote(filters.search));
  if (filters.collectionId) {
    clauses.push(`collection_id:${legacyId(filters.collectionId)}`);
  }
  clauses.push(anyOf("vendor", filters.vendors));
  clauses.push(anyOf("product_type", filters.productTypes));
  clauses.push(anyOf("tag", filters.tags));

  // `status` is an enum in search syntax — unquoted, uppercase.
  if (filters.statuses.length) {
    const terms = filters.statuses.map((status) => `status:${status}`);
    clauses.push(terms.length === 1 ? terms[0] : `(${terms.join(" OR ")})`);
  }

  // `price` on the products connection matches a product with ANY variant in
  // range. Narrowing to the individual variants happens in variant view.
  clauses.push(...range("price", filters.priceMin, filters.priceMax));
  clauses.push(
    ...range("inventory_total", filters.inventoryMin, filters.inventoryMax),
  );
  if (filters.skuPrefix) clauses.push(prefix("sku", filters.skuPrefix));

  return clauses.filter(Boolean).join(" AND ");
}

export interface VariantLike {
  price: string;
  sku: string | null;
  inventoryQuantity: number | null;
}

/**
 * Variant-level narrowing applied in the loader.
 *
 * The `productVariants` connection can't filter by price at all, and the
 * `products` connection's `price`/`inventory_total`/`sku` terms match a
 * *product* that has any variant in range — so in variant view they'd let
 * through the out-of-range siblings of a matching variant. For a bulk price
 * editor that would be a live footgun, so we re-check each variant here.
 */
export function variantMatchesFilters(
  variant: VariantLike,
  filters: SelectFilters,
): boolean {
  const price = Number.parseFloat(variant.price);
  if (filters.priceMin !== "" && !(price >= Number(filters.priceMin))) {
    return false;
  }
  if (filters.priceMax !== "" && !(price <= Number(filters.priceMax))) {
    return false;
  }

  const quantity = variant.inventoryQuantity ?? 0;
  if (filters.inventoryMin !== "" && !(quantity >= Number(filters.inventoryMin))) {
    return false;
  }
  if (filters.inventoryMax !== "" && !(quantity <= Number(filters.inventoryMax))) {
    return false;
  }

  if (filters.skuPrefix) {
    const sku = variant.sku ?? "";
    if (!sku.toLowerCase().startsWith(filters.skuPrefix.toLowerCase())) {
      return false;
    }
  }

  return true;
}

/** True when the filter set narrows variants within an already-matched product. */
export function hasVariantLevelFilters(filters: SelectFilters): boolean {
  return Boolean(
    filters.priceMin ||
      filters.priceMax ||
      filters.skuPrefix ||
      filters.inventoryMin ||
      filters.inventoryMax,
  );
}

// --- helpers ----------------------------------------------------------------

/** Keep only well-formed decimals; anything else round-trips as blank. */
function numeric(value: string): string {
  return /^\d+(\.\d+)?$/.test(value) ? value : "";
}
