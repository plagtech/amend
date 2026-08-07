/**
 * Seeds a development store with a realistic catalog for testing Amend's
 * SELECT step and, later, the acceptance test in SPEC §9 (1,000-product store,
 * filter to a ~300-product collection, edit, undo).
 *
 * Produces, by default: 8 collections, 1,000 products, 3 variants each
 * (3,000 variants), spread across vendors, product types, tags, statuses,
 * prices, and inventory levels so every filter in the panel has something to
 * bite on.
 *
 * Usage:
 *   1. In the dev store: Settings → Apps and sales channels → Develop apps →
 *      create an app, grant `write_products` + `read_products`, install it,
 *      and copy the Admin API access token (`shpat_…`).
 *   2. Add to `.env`:
 *        SEED_SHOP_DOMAIN=your-store.myshopify.com
 *        SEED_ADMIN_TOKEN=shpat_xxxxxxxx
 *   3. npm run seed              # 1,000 products
 *      npm run seed -- --count 50 --dry-run
 *      npm run seed -- --destroy # remove everything this script created
 *
 * Everything it creates is tagged `amend-seed`, which is what `--destroy`
 * matches on — it will never touch products it didn't make.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const API_VERSION = "2026-07";
const SEED_TAG = "amend-seed";
const DEFAULT_COUNT = 1000;
const VARIANTS_PER_PRODUCT = 3;

// --- catalog vocabulary -----------------------------------------------------

const VENDORS = [
  "Northwind Supply",
  "Atlas Goods",
  "Harbour & Co",
  "Kestrel Outdoors",
  "Marlow Home",
  "Pine Street Studio",
  "Vantage Athletics",
  "Wilder Provisions",
];

const PRODUCT_TYPES = [
  "T-Shirt",
  "Hoodie",
  "Jacket",
  "Backpack",
  "Water Bottle",
  "Mug",
  "Notebook",
  "Sneakers",
  "Cap",
  "Socks",
];

const MATERIALS = [
  "Organic Cotton",
  "Merino",
  "Recycled Nylon",
  "Stoneware",
  "Canvas",
  "Linen",
  "Leather",
  "Bamboo",
];

const COLOURS = [
  "Slate",
  "Ochre",
  "Sage",
  "Ink",
  "Sand",
  "Rust",
  "Fern",
  "Bone",
  "Cobalt",
  "Clay",
];

const TAG_POOL = [
  "new-arrival",
  "bestseller",
  "clearance",
  "summer",
  "winter",
  "eco",
  "limited",
  "gift",
  "bundle",
  "staff-pick",
  "restock",
  "outlet",
];

const COLLECTIONS = [
  "Summer Sale",
  "New Arrivals",
  "Outerwear",
  "Accessories",
  "Clearance",
  "Eco Collection",
  "Best Sellers",
  "Gift Guide",
];

const SIZES = ["Small", "Medium", "Large"];

// --- deterministic RNG ------------------------------------------------------

/**
 * Seeded PRNG (mulberry32) so repeated runs produce the same catalog. A stable
 * catalog means a regression in filtering is visible as a changed row count
 * rather than noise.
 */
function makeRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Admin API client -------------------------------------------------------

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
  extensions?: {
    cost?: {
      requestedQueryCost: number;
      actualQueryCost: number;
      throttleStatus: {
        maximumAvailable: number;
        currentlyAvailable: number;
        restoreRate: number;
      };
    };
  };
}

class AdminClient {
  private endpoint: string;
  /** Points left in the leaky bucket, tracked from the last response. */
  private available = 1000;

  constructor(
    shop: string,
    private token: string,
  ) {
    this.endpoint = `https://${shop}/admin/api/${API_VERSION}/graphql.json`;
  }

  async request<T>(
    query: string,
    variables: Record<string, unknown> = {},
    attempt = 1,
  ): Promise<T> {
    // Stay ahead of the cost-based limiter instead of waiting to be throttled.
    if (this.available < 200) {
      await sleep(1000);
      this.available += 100;
    }

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": this.token,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (response.status === 429 || response.status >= 500) {
      if (attempt > 6) {
        throw new Error(`Shopify returned ${response.status} after 6 attempts`);
      }
      const wait = Math.min(30_000, 500 * 2 ** attempt);
      console.warn(`  ↻ HTTP ${response.status}, retrying in ${wait}ms`);
      await sleep(wait);
      return this.request<T>(query, variables, attempt + 1);
    }

    if (!response.ok) {
      throw new Error(
        `Shopify returned ${response.status}: ${await response.text()}`,
      );
    }

    const body = (await response.json()) as GraphQLResponse<T>;
    const throttle = body.extensions?.cost?.throttleStatus;
    if (throttle) this.available = throttle.currentlyAvailable;

    const throttled = body.errors?.some((error) =>
      /throttl/i.test(error.message),
    );
    if (throttled) {
      if (attempt > 6) throw new Error("Throttled after 6 attempts");
      await sleep(Math.min(30_000, 1000 * 2 ** attempt));
      return this.request<T>(query, variables, attempt + 1);
    }

    if (body.errors?.length) {
      throw new Error(body.errors.map((error) => error.message).join("; "));
    }
    if (!body.data) throw new Error("Shopify returned no data");
    return body.data;
  }
}

// --- GraphQL documents ------------------------------------------------------

const LOCATION_QUERY = `
  query SeedLocation {
    locations(first: 1, includeInactive: false) {
      nodes { id name }
    }
  }
`;

const COLLECTION_CREATE = `
  mutation SeedCollectionCreate($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection { id title }
      userErrors { field message }
    }
  }
`;

const PRODUCT_CREATE = `
  mutation SeedProductCreate($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product {
        id
        variants(first: 1) { nodes { id } }
      }
      userErrors { field message }
    }
  }
`;

const VARIANTS_CREATE = `
  mutation SeedVariantsCreate(
    $productId: ID!
    $variants: [ProductVariantsBulkInput!]!
  ) {
    productVariantsBulkCreate(
      productId: $productId
      variants: $variants
      strategy: REMOVE_STANDALONE_VARIANT
    ) {
      productVariants { id }
      userErrors { field message }
    }
  }
`;

const SEED_PRODUCTS_QUERY = `
  query SeedProducts($cursor: String) {
    products(first: 250, after: $cursor, query: "tag:${SEED_TAG}") {
      pageInfo { hasNextPage endCursor }
      nodes { id }
    }
  }
`;

const PRODUCT_DELETE = `
  mutation SeedProductDelete($input: ProductDeleteInput!) {
    productDelete(input: $input) {
      deletedProductId
      userErrors { field message }
    }
  }
`;

const SEED_COLLECTIONS_QUERY = `
  query SeedCollections {
    collections(first: 250) {
      nodes { id title }
    }
  }
`;

const COLLECTION_DELETE = `
  mutation SeedCollectionDelete($input: CollectionDeleteInput!) {
    collectionDelete(input: $input) {
      deletedCollectionId
      userErrors { field message }
    }
  }
`;

// --- product generation -----------------------------------------------------

interface SeedProduct {
  title: string;
  handle: string;
  vendor: string;
  productType: string;
  status: "ACTIVE" | "DRAFT" | "ARCHIVED";
  tags: string[];
  descriptionHtml: string;
  collectionIds: string[];
  basePrice: number;
  compareAt: number | null;
  skuRoot: string;
}

function generateProduct(
  index: number,
  random: () => number,
  collectionIds: string[],
): SeedProduct {
  const pick = <T,>(items: T[]): T =>
    items[Math.floor(random() * items.length)];

  const vendor = pick(VENDORS);
  const productType = pick(PRODUCT_TYPES);
  const material = pick(MATERIALS);
  const colour = pick(COLOURS);

  // Status mix mirrors a live catalog: mostly active, a slice of drafts, a
  // handful archived — so status filtering has all three to find.
  const roll = random();
  const status = roll < 0.8 ? "ACTIVE" : roll < 0.95 ? "DRAFT" : "ARCHIVED";

  // Prices span $5–$480 with a long tail, so range filters are meaningful.
  const basePrice = Math.round((5 + random() ** 2 * 475) * 100) / 100;
  const compareAt =
    random() < 0.35 ? Math.round(basePrice * 1.35 * 100) / 100 : null;

  const tagCount = 1 + Math.floor(random() * 3);
  const tags = new Set<string>([SEED_TAG]);
  for (let i = 0; i < tagCount; i += 1) tags.add(pick(TAG_POOL));

  // Each product joins 1–2 collections. "Summer Sale" (the first) carries an
  // extra 18% chance on top of its share of the uniform picks below, which
  // lands it near the ~300-product collection the SPEC acceptance test wants.
  const chosen = new Set<string>();
  if (random() < 0.18) chosen.add(collectionIds[0]);
  chosen.add(pick(collectionIds));
  if (random() < 0.25) chosen.add(pick(collectionIds));

  const number = String(index + 1).padStart(4, "0");

  return {
    title: `${colour} ${material} ${productType} ${number}`,
    handle: `amend-seed-${number}`,
    vendor,
    productType,
    status,
    tags: [...tags],
    descriptionHtml: `<p>A ${material.toLowerCase()} ${productType.toLowerCase()} in ${colour.toLowerCase()}, made by ${vendor}. Seed data for Amend bulk-edit testing.</p>`,
    collectionIds: [...chosen].filter(Boolean),
    basePrice,
    compareAt,
    skuRoot: `AMD-${productType.slice(0, 3).toUpperCase()}-${number}`,
  };
}

function variantInputs(
  product: SeedProduct,
  locationId: string,
  random: () => number,
) {
  return SIZES.map((size, index) => {
    // Larger sizes cost a little more, as a real catalog would.
    const price = Math.round((product.basePrice + index * 4) * 100) / 100;
    return {
      optionValues: [{ optionName: "Size", name: size }],
      price: price.toFixed(2),
      compareAtPrice: product.compareAt
        ? (product.compareAt + index * 4).toFixed(2)
        : null,
      barcode: `${product.skuRoot}-${index + 1}-BC`,
      inventoryItem: {
        sku: `${product.skuRoot}-${size.slice(0, 1)}`,
        tracked: true,
        cost: (price * 0.4).toFixed(2),
      },
      inventoryQuantities: [
        { locationId, availableQuantity: Math.floor(random() * 120) },
      ],
    };
  });
}

// --- dry run ----------------------------------------------------------------

/**
 * Generates the catalog without writing it and reports the spread across every
 * dimension the filter panel exposes. This is the cheap way to confirm the
 * seed will actually exercise the filters — in particular that one collection
 * lands near the ~300 products the SPEC acceptance test needs.
 */
function reportDistribution(count: number, random: () => number) {
  const fakeIds = COLLECTIONS.map((_, i) => `gid://shopify/Collection/${i}`);
  const specs = Array.from({ length: count }, (_, i) =>
    generateProduct(i, random, fakeIds),
  );

  const tally = (values: string[]) => {
    const counts = new Map<string, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  };

  const show = (title: string, rows: [string, number][]) => {
    console.log(`\n${title}`);
    for (const [name, n] of rows) {
      const pct = ((n / count) * 100).toFixed(1).padStart(5);
      console.log(`  ${String(n).padStart(5)}  ${pct}%  ${name}`);
    }
  };

  console.log("Dry run — no writes. First product would be:");
  console.log(JSON.stringify(specs[0], null, 2));

  console.log(
    `\nWould create ${COLLECTIONS.length} collections, ${count} products, ` +
      `${count * VARIANTS_PER_PRODUCT} variants.`,
  );

  show("Status", tally(specs.map((s) => s.status)));
  show(
    "Collection membership",
    tally(
      specs.flatMap((s) =>
        s.collectionIds.map(
          (id) => COLLECTIONS[Number(id.split("/").pop())] ?? id,
        ),
      ),
    ),
  );
  show("Vendor", tally(specs.map((s) => s.vendor)));
  show("Product type", tally(specs.map((s) => s.productType)));
  show("Tags", tally(specs.flatMap((s) => s.tags)));

  const prices = specs.map((s) => s.basePrice).sort((a, b) => a - b);
  const at = (q: number) => prices[Math.floor(prices.length * q)].toFixed(2);
  console.log(
    `\nBase price: min ${prices[0].toFixed(2)} · p25 ${at(0.25)} · median ${at(
      0.5,
    )} · p75 ${at(0.75)} · max ${prices[prices.length - 1].toFixed(2)}`,
  );
  console.log(
    `Handles are unique: ${new Set(specs.map((s) => s.handle)).size === count}`,
  );
  console.log(
    `SKU roots are unique: ${new Set(specs.map((s) => s.skuRoot)).size === count}`,
  );
}

// --- runners ----------------------------------------------------------------

async function seed(client: AdminClient, count: number, dryRun: boolean) {
  const random = makeRandom(20260807);

  if (dryRun) {
    reportDistribution(count, random);
    return;
  }

  const locationData = await client.request<{
    locations: { nodes: { id: string; name: string }[] };
  }>(LOCATION_QUERY);
  const location = locationData.locations.nodes[0];
  if (!location) throw new Error("Store has no active location to stock.");
  console.log(`Stocking inventory at: ${location.name}`);

  console.log(`Creating ${COLLECTIONS.length} collections…`);
  const collectionIds: string[] = [];
  for (const title of COLLECTIONS) {
    const data = await client.request<{
      collectionCreate: {
        collection: { id: string } | null;
        userErrors: { message: string }[];
      };
    }>(COLLECTION_CREATE, {
      input: { title, descriptionHtml: `<p>Amend seed collection.</p>` },
    });
    const errors = data.collectionCreate.userErrors;
    if (errors.length) {
      // A re-run hits "handle already taken" — reuse the existing collection.
      console.warn(`  ! ${title}: ${errors.map((e) => e.message).join(", ")}`);
      continue;
    }
    collectionIds.push(data.collectionCreate.collection!.id);
  }

  if (collectionIds.length === 0) {
    const existing = await client.request<{
      collections: { nodes: { id: string; title: string }[] };
    }>(SEED_COLLECTIONS_QUERY);
    collectionIds.push(
      ...existing.collections.nodes
        .filter((node) => COLLECTIONS.includes(node.title))
        .map((node) => node.id),
    );
  }
  if (collectionIds.length === 0) {
    throw new Error("No collections available to assign products to.");
  }

  console.log(`Creating ${count} products (${VARIANTS_PER_PRODUCT} variants each)…`);
  const started = Date.now();
  let created = 0;
  let failed = 0;

  for (let index = 0; index < count; index += 1) {
    const spec = generateProduct(index, random, collectionIds);
    try {
      const productData = await client.request<{
        productCreate: {
          product: { id: string } | null;
          userErrors: { field: string[]; message: string }[];
        };
      }>(PRODUCT_CREATE, {
        product: {
          title: spec.title,
          handle: spec.handle,
          vendor: spec.vendor,
          productType: spec.productType,
          status: spec.status,
          tags: spec.tags,
          descriptionHtml: spec.descriptionHtml,
          collectionsToJoin: spec.collectionIds,
          productOptions: [
            { name: "Size", values: SIZES.map((name) => ({ name })) },
          ],
        },
      });

      const productErrors = productData.productCreate.userErrors;
      if (productErrors.length || !productData.productCreate.product) {
        throw new Error(productErrors.map((e) => e.message).join(", "));
      }

      const productId = productData.productCreate.product.id;
      const variantData = await client.request<{
        productVariantsBulkCreate: {
          userErrors: { field: string[]; message: string }[];
        };
      }>(VARIANTS_CREATE, {
        productId,
        variants: variantInputs(spec, location.id, random),
      });

      const variantErrors = variantData.productVariantsBulkCreate.userErrors;
      if (variantErrors.length) {
        throw new Error(variantErrors.map((e) => e.message).join(", "));
      }

      created += 1;
    } catch (error) {
      failed += 1;
      console.warn(`  ! ${spec.handle}: ${(error as Error).message}`);
    }

    if ((index + 1) % 50 === 0 || index + 1 === count) {
      const elapsed = (Date.now() - started) / 1000;
      const rate = (index + 1) / elapsed;
      const remaining = Math.round((count - index - 1) / rate);
      console.log(
        `  ${index + 1}/${count} · ${rate.toFixed(1)}/s · ~${remaining}s left`,
      );
    }
  }

  console.log(
    `\nDone: ${created} products (${created * VARIANTS_PER_PRODUCT} variants), ` +
      `${failed} failed, in ${Math.round((Date.now() - started) / 1000)}s.`,
  );
}

async function destroy(client: AdminClient) {
  console.log(`Deleting every product tagged "${SEED_TAG}"…`);
  let deleted = 0;

  // Re-query from the start each round: deleting shifts the cursor window.
  for (;;) {
    const data = await client.request<{
      products: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: { id: string }[];
      };
    }>(SEED_PRODUCTS_QUERY, { cursor: null });

    if (data.products.nodes.length === 0) break;

    for (const node of data.products.nodes) {
      await client.request(PRODUCT_DELETE, { input: { id: node.id } });
      deleted += 1;
      if (deleted % 50 === 0) console.log(`  deleted ${deleted}…`);
    }
  }

  console.log(`Deleted ${deleted} products. Removing seed collections…`);
  const collectionData = await client.request<{
    collections: { nodes: { id: string; title: string }[] };
  }>(SEED_COLLECTIONS_QUERY);

  for (const node of collectionData.collections.nodes) {
    if (!COLLECTIONS.includes(node.title)) continue;
    await client.request(COLLECTION_DELETE, { input: { id: node.id } });
    console.log(`  removed ${node.title}`);
  }

  console.log("Done.");
}

// --- entry point ------------------------------------------------------------

function loadEnvFile() {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;
      const [, key, value] = match;
      if (process.env[key] === undefined) {
        process.env[key] = value.replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // No .env — rely on the ambient environment.
  }
}

function parseArgs(argv: string[]) {
  const countIndex = argv.indexOf("--count");
  return {
    count:
      countIndex >= 0 ? Number.parseInt(argv[countIndex + 1], 10) : DEFAULT_COUNT,
    dryRun: argv.includes("--dry-run"),
    destroy: argv.includes("--destroy"),
  };
}

async function main() {
  loadEnvFile();
  const args = parseArgs(process.argv.slice(2));

  const shop = process.env.SEED_SHOP_DOMAIN;
  const token = process.env.SEED_ADMIN_TOKEN;

  if (!args.dryRun && (!shop || !token)) {
    console.error(
      "Set SEED_SHOP_DOMAIN and SEED_ADMIN_TOKEN in .env (see the header of\n" +
        "this file for how to mint a dev-store Admin API token).",
    );
    process.exit(1);
  }

  if (!Number.isFinite(args.count) || args.count < 1) {
    console.error("--count must be a positive integer.");
    process.exit(1);
  }

  const client = new AdminClient(shop ?? "", token ?? "");

  if (args.destroy) {
    await destroy(client);
    return;
  }

  console.log(
    `Seeding ${shop ?? "(dry run)"} — ${args.count} products, ` +
      `${args.count * VARIANTS_PER_PRODUCT} variants.`,
  );
  await seed(client, args.count, args.dryRun);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(`\nSeed failed: ${(error as Error).message}`);
  process.exit(1);
});
