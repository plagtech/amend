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
import type { ProductStatus, SelectFilters } from "./filters";
import { buildProductQuery, variantMatchesFilters } from "./filters";

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
  { filters, sortKey, reverse, cursor, direction }: FetchPageArgs,
): Promise<ProductPage> {
  const variantView = filters.view === "variant";
  const pageSize = variantView ? VARIANT_VIEW_PAGE_SIZE : PRODUCT_PAGE_SIZE;
  const query = buildProductQuery(filters);
  const backwards = direction === "prev" && cursor !== null;

  const response = await admin.graphql(PRODUCT_PAGE_QUERY, {
    variables: {
      first: backwards ? null : pageSize,
      last: backwards ? pageSize : null,
      after: backwards ? null : cursor,
      before: backwards ? cursor : null,
      query: query || null,
      sortKey,
      reverse,
      variantLimit: VARIANTS_PER_PRODUCT,
      includeVariants: variantView,
    },
  });

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

  const products = body.data.products.nodes.map((node) =>
    toProductRow(node, filters, variantView),
  );

  const rowIds = variantView
    ? products.flatMap((product) => product.variants.map((v) => v.id))
    : products.map((product) => product.id);

  return {
    products,
    pageInfo: body.data.products.pageInfo,
    totalProducts: body.data.productsCount?.count ?? products.length,
    totalIsLowerBound: body.data.productsCount?.precision !== "EXACT",
    rowIds,
    variantsOnPage: variantView ? rowIds.length : 0,
    query,
  };
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

interface ProductNode {
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
