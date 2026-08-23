/**
 * Server-side reads for the SELECT step: one page of filtered products (or
 * products with their variants expanded), plus the facet lists that populate
 * the filter panel.
 *
 * Both views are driven by the `products` connection rather than switching to
 * `productVariants` for variant view. That connection is the only one whose
 * search syntax covers every filter in the panel (`productVariants` has no
 * price term at all), and paging by product keeps variants grouped under their
 * parent — which is how a merchant reasons about a bulk edit anyway.
 */

import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

import type {
  Facets,
  FacetOption,
  PageInfo,
  ProductPage,
  ProductRow,
  SortKey,
  VariantRow,
} from "./catalog";
import {
  PRODUCT_PAGE_SIZE,
  VARIANTS_PER_PRODUCT,
  VARIANT_VIEW_PAGE_SIZE,
} from "./catalog";
import type {
  ProductLike,
  ProductStatus,
  ResidualFilters,
  SelectFilters,
} from "./filters";
import {
  planProductQuery,
  productMatchesResidual,
  residualNeedsVariants,
  variantMatchesFilters,
} from "./filters";

const PRODUCT_PAGE_QUERY = `#graphql
  query AmendSelectProducts(
    $first: Int
    $last: Int
    $after: String
    $before: String
    $query: String
    $sortKey: ProductSortKeys
    $reverse: Boolean
    $variantLimit: Int!
    $includeVariants: Boolean!
  ) {
    productsCount(query: $query) {
      count
      precision
    }
    products(
      first: $first
      last: $last
      after: $after
      before: $before
      query: $query
      sortKey: $sortKey
      reverse: $reverse
    ) {
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
      nodes {
        id
        title
        handle
        vendor
        productType
        status
        tags
        totalInventory
        variantsCount {
          count
        }
        priceRangeV2 {
          minVariantPrice {
            amount
            currencyCode
          }
          maxVariantPrice {
            amount
            currencyCode
          }
        }
        featuredMedia {
          preview {
            image {
              url
              altText
            }
          }
        }
        variants(first: $variantLimit) @include(if: $includeVariants) {
          nodes {
            id
            title
            sku
            price
            compareAtPrice
            inventoryQuantity
          }
        }
      }
    }
  }
`;

const FACETS_QUERY = `#graphql
  query AmendSelectFacets {
    productVendors(first: 250) {
      edges {
        node
      }
    }
    productTypes(first: 250) {
      edges {
        node
      }
    }
    productTags(first: 250) {
      edges {
        node
      }
    }
    collections(first: 250, sortKey: TITLE) {
      nodes {
        id
        title
        productsCount {
          count
        }
      }
    }
  }
`;

export interface FetchPageArgs {
  filters: SelectFilters;
  sortKey: SortKey;
  reverse: boolean;
  cursor: string | null;
  /** "prev" pages backwards with `last`/`before`. */
  direction: "next" | "prev";
}

export async function fetchProductPage(
  admin: AdminApiContext,
  args: FetchPageArgs,
): Promise<ProductPage> {
  const plan = planProductQuery(args.filters);
  return plan.residual
    ? scanProductPage(admin, args, plan.query, plan.residual)
    : fetchDirectPage(admin, args, plan.query);
}

/**
 * The common path: Shopify can answer the whole filter set, so one request
 * gives us a page, its cursors, and an exact total.
 */
async function fetchDirectPage(
  admin: AdminApiContext,
  { filters, sortKey, reverse, cursor, direction }: FetchPageArgs,
  query: string,
): Promise<ProductPage> {
  const variantView = filters.view === "variant";
  const pageSize = variantView ? VARIANT_VIEW_PAGE_SIZE : PRODUCT_PAGE_SIZE;
  const backwards = direction === "prev" && cursor !== null;

  const data = await runPageQuery(admin, {
    first: backwards ? null : pageSize,
    last: backwards ? pageSize : null,
    after: backwards ? null : cursor,
    before: backwards ? cursor : null,
    query: query || null,
    sortKey,
    reverse,
    variantLimit: VARIANTS_PER_PRODUCT,
    includeVariants: variantView,
  });

  const products = data.products.nodes.map((node) =>
    toProductRow(node, filters, variantView),
  );

  return {
    products,
    pageInfo: data.products.pageInfo,
    totalProducts: data.productsCount?.count ?? products.length,
    totalIsLowerBound: data.productsCount?.precision !== "EXACT",
    ...rowStats(products, variantView),
    query,
  };
}

/** Products pulled per scan request. 250 is the connection's ceiling. */
const SCAN_PAGE_SIZE = 250;

/**
 * Ceiling on a single scan, in products. Twenty requests is already a slow
 * page load; past this the total is reported as a lower bound ("5,000+") rather
 * than making the merchant wait on a collection nobody bulk-edits in one go.
 */
const SCAN_PRODUCT_CAP = 5000;

const SYNTHETIC_CURSOR = "amend:offset:";

/**
 * The collection path: `query` is a superset (see the table in `filters.ts`),
 * so we page the whole thing and apply `residual` ourselves.
 *
 * That rules out Shopify's cursors — they index the unfiltered stream, not the
 * rows the merchant ends up seeing — so this scans from the top and paginates
 * over the narrowed list by offset. Scanning from the top each time is also
 * what makes the total exact, which the select-all-matching flow leans on.
 */
async function scanProductPage(
  admin: AdminApiContext,
  { filters, sortKey, reverse, cursor }: FetchPageArgs,
  query: string,
  residual: ResidualFilters,
): Promise<ProductPage> {
  const variantView = filters.view === "variant";
  const pageSize = variantView ? VARIANT_VIEW_PAGE_SIZE : PRODUCT_PAGE_SIZE;

  const { products: matched, truncated } = await collectMatchingProducts(
    admin,
    {
      filters,
      sortKey,
      reverse,
      includeVariants: variantView || residualNeedsVariants(residual),
    },
  );

  const offset = Math.min(
    Math.max(0, decodeOffset(cursor)),
    Math.max(0, matched.length - 1),
  );
  const products = matched
    .slice(offset, offset + pageSize)
    .map((node) => toProductRow(node, filters, variantView));

  const hasNextPage = offset + pageSize < matched.length || truncated;
  const hasPreviousPage = offset > 0;

  return {
    products,
    pageInfo: {
      hasNextPage,
      hasPreviousPage,
      startCursor: hasPreviousPage
        ? `${SYNTHETIC_CURSOR}${Math.max(0, offset - pageSize)}`
        : null,
      endCursor: hasNextPage ? `${SYNTHETIC_CURSOR}${offset + pageSize}` : null,
    },
    totalProducts: matched.length,
    totalIsLowerBound: truncated,
    ...rowStats(products, variantView),
    query,
  };
}

export interface CollectArgs {
  filters: SelectFilters;
  sortKey: SortKey;
  reverse: boolean;
  includeVariants: boolean;
  /** Products fetched before giving up. Defaults to `SCAN_PRODUCT_CAP`. */
  cap?: number;
  /** Products per request. Lower it when variants make each node expensive. */
  pageSize?: number;
}

/**
 * Every product matching `filters`, in sort order, with the residual filters
 * already applied.
 *
 * Shared by the collection-filter pagination path and by preview, which both
 * need the whole matching set rather than a page: one to count and slice it,
 * the other to diff it. `truncated` is true when the cap cut the scan short,
 * and every caller has to surface that rather than quietly under-report.
 */
export async function collectMatchingProducts(
  admin: AdminApiContext,
  { filters, sortKey, reverse, includeVariants, cap, pageSize }: CollectArgs,
): Promise<{ products: ProductNode[]; truncated: boolean }> {
  const plan = planProductQuery(filters);
  const limit = cap ?? SCAN_PRODUCT_CAP;
  const perRequest = pageSize ?? SCAN_PAGE_SIZE;

  const products: ProductNode[] = [];
  let after: string | null = null;
  let scanned = 0;
  let truncated = false;

  for (;;) {
    const data: ProductPageResponse = await runPageQuery(admin, {
      first: perRequest,
      last: null,
      after,
      before: null,
      query: plan.query || null,
      sortKey,
      reverse,
      variantLimit: VARIANTS_PER_PRODUCT,
      includeVariants,
    });

    for (const node of data.products.nodes) {
      if (
        plan.residual &&
        !productMatchesResidual(toProductLike(node), plan.residual)
      ) {
        continue;
      }
      products.push(node);
    }
    scanned += data.products.nodes.length;

    if (!data.products.pageInfo.hasNextPage) break;
    if (scanned >= limit) {
      truncated = true;
      break;
    }
    after = data.products.pageInfo.endCursor;
  }

  return { products, truncated };
}

function decodeOffset(cursor: string | null): number {
  if (!cursor || !cursor.startsWith(SYNTHETIC_CURSOR)) return 0;
  const offset = Number.parseInt(cursor.slice(SYNTHETIC_CURSOR.length), 10);
  return Number.isFinite(offset) ? offset : 0;
}

function rowStats(products: ProductRow[], variantView: boolean) {
  const rowIds = variantView
    ? products.flatMap((product) => product.variants.map((v) => v.id))
    : products.map((product) => product.id);
  return { rowIds, variantsOnPage: variantView ? rowIds.length : 0 };
}

async function runPageQuery(
  admin: AdminApiContext,
  variables: Record<string, unknown>,
): Promise<ProductPageResponse> {
  const response = await admin.graphql(PRODUCT_PAGE_QUERY, { variables });
  const body = (await response.json()) as {
    data?: ProductPageResponse;
    errors?: { message: string }[];
  };

  if (body.errors?.length) {
    throw new Error(
      `Shopify product search failed: ${body.errors
        .map((error) => error.message)
        .join("; ")}`,
    );
  }
  if (!body.data) {
    throw new Error("Shopify product search returned no data.");
  }
  return body.data;
}

export async function fetchFacets(admin: AdminApiContext): Promise<Facets> {
  const response = await admin.graphql(FACETS_QUERY);
  const body = (await response.json()) as {
    data?: FacetsResponse;
    errors?: { message: string }[];
  };

  if (body.errors?.length || !body.data) {
    // A missing facet list degrades the panel to free-text filtering rather
    // than failing the page — the filters still compile and run without it.
    return { vendors: [], productTypes: [], tags: [], collections: [] };
  }

  const scalars = (edges: { node: string }[]): FacetOption[] =>
    edges
      .map((edge) => edge.node)
      .filter(Boolean)
      .map((value) => ({ label: value, value }));

  return {
    vendors: scalars(body.data.productVendors.edges),
    productTypes: scalars(body.data.productTypes.edges),
    tags: scalars(body.data.productTags.edges),
    collections: body.data.collections.nodes.map((node) => ({
      label: `${node.title} (${node.productsCount?.count ?? 0})`,
      value: node.id,
    })),
  };
}

// --- response shapes --------------------------------------------------------

export interface ProductNode {
  id: string;
  title: string;
  handle: string;
  vendor: string;
  productType: string;
  status: ProductStatus;
  tags: string[];
  totalInventory: number | null;
  variantsCount: { count: number } | null;
  priceRangeV2: {
    minVariantPrice: { amount: string; currencyCode: string };
    maxVariantPrice: { amount: string; currencyCode: string };
  };
  featuredMedia: {
    preview: { image: { url: string; altText: string | null } | null } | null;
  } | null;
  variants?: { nodes: VariantRow[] };
}

interface ProductPageResponse {
  productsCount: { count: number; precision: string } | null;
  products: { pageInfo: PageInfo; nodes: ProductNode[] };
}

interface FacetsResponse {
  productVendors: { edges: { node: string }[] };
  productTypes: { edges: { node: string }[] };
  productTags: { edges: { node: string }[] };
  collections: {
    nodes: { id: string; title: string; productsCount: { count: number } | null }[];
  };
}

/** Adapts a raw node to the shape `productMatchesResidual` reads. */
function toProductLike(node: ProductNode): ProductLike {
  return {
    title: node.title,
    handle: node.handle,
    vendor: node.vendor,
    productType: node.productType,
    tags: node.tags,
    minPrice: node.priceRangeV2.minVariantPrice.amount,
    maxPrice: node.priceRangeV2.maxVariantPrice.amount,
    totalInventory: node.totalInventory,
    variants: node.variants?.nodes ?? [],
  };
}

function toProductRow(
  node: ProductNode,
  filters: SelectFilters,
  variantView: boolean,
): ProductRow {
  const fetched = node.variants?.nodes ?? [];
  const variants = variantView
    ? fetched.filter((variant) => variantMatchesFilters(variant, filters))
    : [];
  const variantCount = node.variantsCount?.count ?? fetched.length;

  return {
    id: node.id,
    title: node.title,
    handle: node.handle,
    vendor: node.vendor,
    productType: node.productType,
    status: node.status,
    tags: node.tags,
    totalInventory: node.totalInventory ?? 0,
    variantCount,
    imageUrl: node.featuredMedia?.preview?.image?.url ?? null,
    imageAlt: node.featuredMedia?.preview?.image?.altText ?? null,
    minPrice: node.priceRangeV2.minVariantPrice.amount,
    maxPrice: node.priceRangeV2.maxVariantPrice.amount,
    currencyCode: node.priceRangeV2.minVariantPrice.currencyCode,
    variants,
    moreVariants: Math.max(0, variantCount - fetched.length),
  };
}
