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

// --- the collection_id composition limit ------------------------------------

/**
 * `collection_id` does not compose with every other search term.
 *
 * Shopify accepts `collection_id:123 AND price:<=20`, returns HTTP 200, reports
 * `precision: EXACT` — and answers **zero**. It is not a syntax error and there
 * is no warning; the term is simply dropped on the floor along with every row.
 * Measured against a 1,000-product seed store where the correct answers are
 * known from the seed's PRNG (`scripts/seed-products.ts`):
 *
 *   term                        alone   AND collection_id   truth
 *   vendor:'Atlas Goods'          130                  37      37  ok
 *   product_type:'Hoodie'         102                  30      30  ok
 *   status:ACTIVE                 789                 235     235  ok
 *   handle:amend-seed-0001          1                   1       1  ok
 *   tag:'summer'                  157                   0      41  DROPPED
 *   price:>=10 AND price:<=20     191                   0      49  DROPPED
 *   sku:AMD*                     1000                   0     296  DROPPED
 *   inventory_total:>=1          1000                   0     296  DROPPED
 *   'Hoodie' (free text)          102                   0      30  DROPPED
 *
 * The split is exactly "column on the product record" vs "needs a join to
 * variants or tags": adding `collection_id` moves the search onto a path that
 * cannot see the joined fields, and a term it cannot see matches nothing.
 *
 * `collection(id:).products` is not a way out either — that connection takes no
 * `query` argument at all. Neither is `productVariants(query:)`, which ignores
 * `price` outright (it happily returns a $95.77 variant for `price:<=20`).
 *
 * So when a collection is combined with any dropped term, the loader pushes
 * only the composable half to Shopify and applies the rest itself. See
 * `planProductQuery` and `productMatchesResidual`.
 *
 * Filters that have to be applied in-process alongside a collection filter:
 */
export interface ResidualFilters {
  search: string;
  tags: string[];
  priceMin: string;
  priceMax: string;
  inventoryMin: string;
  inventoryMax: string;
  skuPrefix: string;
}

export interface QueryPlan {
  /** The `query:` argument to send to the `products` connection. */
  query: string;
  /**
   * Non-null when Shopify can't be trusted with the whole filter set, in which
   * case `query` is a *superset* and the loader must narrow it in-process.
   */
  residual: ResidualFilters | null;
}

function residualOf(filters: SelectFilters): ResidualFilters | null {
  const residual: ResidualFilters = {
    search: filters.search,
    tags: filters.tags,
    priceMin: filters.priceMin,
    priceMax: filters.priceMax,
    inventoryMin: filters.inventoryMin,
    inventoryMax: filters.inventoryMax,
    skuPrefix: filters.skuPrefix,
  };
  const empty =
    !residual.search &&
    residual.tags.length === 0 &&
    !residual.priceMin &&
    !residual.priceMax &&
    !residual.inventoryMin &&
    !residual.inventoryMax &&
    !residual.skuPrefix;
  return empty ? null : residual;
}

/**
 * Decide how much of a filter set Shopify can answer on its own.
 *
 * Without a collection filter that's all of it, and the loader takes the cheap
 * one-request path. With one, the terms listed as DROPPED above are held back.
 */
export function planProductQuery(filters: SelectFilters): QueryPlan {
  if (!filters.collectionId) {
    return { query: buildProductQuery(filters), residual: null };
  }

  const residual = residualOf(filters);
  if (!residual) {
    return { query: buildProductQuery(filters), residual: null };
  }

  // Only the terms proven to survive alongside `collection_id`.
  const clauses: (string | null)[] = [
    `collection_id:${legacyId(filters.collectionId)}`,
    anyOf("vendor", filters.vendors),
    anyOf("product_type", filters.productTypes),
  ];
  if (filters.statuses.length) {
    const terms = filters.statuses.map((status) => `status:${status}`);
    clauses.push(terms.length === 1 ? terms[0] : `(${terms.join(" OR ")})`);
  }

  return { query: clauses.filter(Boolean).join(" AND "), residual };
}

/** True when a plan's residual filters need variant rows to be evaluated. */
export function residualNeedsVariants(residual: ResidualFilters): boolean {
  return residual.skuPrefix !== "";
}

export interface ProductLike {
  title: string;
  handle: string;
  vendor: string;
  productType: string;
  tags: string[];
  /** `priceRangeV2` bounds — the cheapest and dearest variant. */
  minPrice: string;
  maxPrice: string;
  totalInventory: number | null;
  /** Fetched only when `residualNeedsVariants` or variant view asked for them. */
  variants: { sku: string | null }[];
}

/**
 * Re-implements the held-back terms at product level, matching the semantics
 * Shopify uses when it evaluates them itself.
 *
 * `price` and `inventory_total` are product-level there: each term is tested
 * against the product's whole variant set independently, so `price:>=10 AND
 * price:<=20` keeps any product whose price range *overlaps* $10–$20. This
 * function reproduces that overlap test rather than a stricter one so the two
 * paths agree; variant view then narrows to the individual variants that really
 * are in range via `variantMatchesFilters`.
 *
 * `search` is the one approximation. Shopify's default product search is a
 * weighted multi-field match we can't reproduce exactly, so this does a
 * case-insensitive substring sweep over the fields it draws on.
 */
export function productMatchesResidual(
  product: ProductLike,
  residual: ResidualFilters,
): boolean {
  if (residual.tags.length) {
    const owned = new Set(product.tags.map((tag) => tag.toLowerCase()));
    if (!residual.tags.some((tag) => owned.has(tag.toLowerCase()))) return false;
  }

  const min = Number.parseFloat(product.minPrice);
  const max = Number.parseFloat(product.maxPrice);
  if (residual.priceMin !== "" && !(max >= Number(residual.priceMin))) {
    return false;
  }
  if (residual.priceMax !== "" && !(min <= Number(residual.priceMax))) {
    return false;
  }

  const inventory = product.totalInventory ?? 0;
  if (
    residual.inventoryMin !== "" &&
    !(inventory >= Number(residual.inventoryMin))
  ) {
    return false;
  }
  if (
    residual.inventoryMax !== "" &&
    !(inventory <= Number(residual.inventoryMax))
  ) {
    return false;
  }

  if (residual.skuPrefix) {
    const needle = residual.skuPrefix.toLowerCase();
    const hit = product.variants.some((variant) =>
      (variant.sku ?? "").toLowerCase().startsWith(needle),
    );
    if (!hit) return false;
  }

  if (residual.search) {
    const needle = residual.search.toLowerCase();
    const haystack = [
      product.title,
      product.handle,
      product.vendor,
      product.productType,
      ...product.tags,
      ...product.variants.map((variant) => variant.sku ?? ""),
    ]
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }

  return true;
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
