/**
 * Runs the real SELECT loader (`fetchProductPage`) against a seeded dev store
 * and checks the row counts against ground truth computed from the seed's PRNG.
 *
 * This exists because the failure it guards is silent: Shopify answers
 * `collection_id:… AND price:<=20` with HTTP 200, `precision: EXACT`, and zero
 * rows. Nothing throws, so only a count can catch it.
 *
 *   SEED_SHOP_DOMAIN=… SEED_ADMIN_TOKEN=… npx tsx scripts/verify-filters.ts
 *
 * Assumes the store was seeded by `npm run seed` with its default 1,000
 * products and no edits since.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

import { emptyFilters } from "../app/lib/filters";
import type { SelectFilters } from "../app/lib/filters";
import { fetchProductPage } from "../app/lib/products.server";

/** Keep in step with `ApiVersion.July26` in `app/shopify.server.ts`. */
const API_VERSION = "2026-07";
const SEED_TAG = "amend-seed";

// --- ground truth from the seed's PRNG --------------------------------------

const VENDORS = ["Northwind Supply","Atlas Goods","Harbour & Co","Kestrel Outdoors","Marlow Home","Pine Street Studio","Vantage Athletics","Wilder Provisions"];
const PRODUCT_TYPES = ["T-Shirt","Hoodie","Jacket","Backpack","Water Bottle","Mug","Notebook","Sneakers","Cap","Socks"];
const MATERIALS = ["Organic Cotton","Merino","Recycled Nylon","Stoneware","Canvas","Linen","Leather","Bamboo"];
const COLOURS = ["Slate","Ochre","Sage","Ink","Sand","Rust","Fern","Bone","Cobalt","Clay"];
const TAG_POOL = ["new-arrival","bestseller","clearance","summer","winter","eco","limited","gift","bundle","staff-pick","restock","outlet"];
const COLLECTIONS = ["Summer Sale","New Arrivals","Outerwear","Accessories","Clearance","Eco Collection","Best Sellers","Gift Guide"];
const SIZES = ["Small", "Medium", "Large"];

interface Truth {
  handle: string;
  title: string;
  vendor: string;
  productType: string;
  status: string;
  tags: string[];
  collections: number[];
  prices: number[];
  totalInventory: number;
}

/**
 * Mirrors `seed-products.ts` draw for draw, including the three inventory draws
 * `variantInputs` makes per product. Skipping those is what makes `--dry-run`
 * predict a different catalog than the one a real run creates.
 */
function groundTruth(count = 1000): Truth[] {
  let state = 20260807 >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T,>(items: T[]): T => items[Math.floor(random() * items.length)];

  const out: Truth[] = [];
  for (let index = 0; index < count; index += 1) {
    const vendor = pick(VENDORS);
    const productType = pick(PRODUCT_TYPES);
    const material = pick(MATERIALS);
    const colour = pick(COLOURS);
    const roll = random();
    const status = roll < 0.8 ? "ACTIVE" : roll < 0.95 ? "DRAFT" : "ARCHIVED";
    const basePrice = Math.round((5 + random() ** 2 * 475) * 100) / 100;
    random(); // compareAt roll
    const tagCount = 1 + Math.floor(random() * 3);
    const tags = new Set<string>([SEED_TAG]);
    for (let i = 0; i < tagCount; i += 1) tags.add(pick(TAG_POOL));
    const collections = new Set<number>();
    if (random() < 0.18) collections.add(0);
    collections.add(Math.floor(random() * COLLECTIONS.length));
    if (random() < 0.25) collections.add(Math.floor(random() * COLLECTIONS.length));
    const number = String(index + 1).padStart(4, "0");
    const inventory = SIZES.map(() => Math.floor(random() * 120));

    out.push({
      handle: `amend-seed-${number}`,
      title: `${colour} ${material} ${productType} ${number}`,
      vendor,
      productType,
      status,
      tags: [...tags],
      collections: [...collections],
      prices: SIZES.map((_, i) => Math.round((basePrice + i * 4) * 100) / 100),
      totalInventory: inventory.reduce((a, b) => a + b, 0),
    });
  }
  return out;
}

// --- a minimal AdminApiContext backed by the seed token ---------------------

function stubAdmin(shop: string, token: string): AdminApiContext {
  return {
    graphql: async (query: string, options?: { variables?: unknown }) =>
      fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({ query, variables: options?.variables ?? {} }),
      }),
  } as unknown as AdminApiContext;
}

// --- checks -----------------------------------------------------------------

interface Case {
  name: string;
  filters: Partial<SelectFilters>;
  expected: (truth: Truth[]) => number;
}

const inRange = (prices: number[], min: number, max: number) =>
  prices.some((price) => price >= min && price <= max);

function buildCases(collectionIndex: number): Case[] {
  const summer = (t: Truth) => t.collections.includes(collectionIndex);
  return [
    {
      name: "collection alone",
      filters: { collectionId: "COLLECTION" },
      expected: (truth) => truth.filter(summer).length,
    },
    {
      name: "price 10-20, no collection",
      filters: { priceMin: "10", priceMax: "20" },
      expected: (truth) =>
        truth.filter((t) => inRange(t.prices, 10, 20)).length,
    },
    {
      name: "collection + price 10-20",
      filters: { collectionId: "COLLECTION", priceMin: "10", priceMax: "20" },
      expected: (truth) =>
        truth.filter((t) => summer(t) && inRange(t.prices, 10, 20)).length,
    },
    {
      name: "collection + tag summer",
      filters: { collectionId: "COLLECTION", tags: ["summer"] },
      expected: (truth) =>
        truth.filter((t) => summer(t) && t.tags.includes("summer")).length,
    },
    {
      name: "collection + vendor (composable, was already fine)",
      filters: { collectionId: "COLLECTION", vendors: ["Atlas Goods"] },
      expected: (truth) =>
        truth.filter((t) => summer(t) && t.vendor === "Atlas Goods").length,
    },
    {
      name: "collection + status ACTIVE (composable)",
      filters: { collectionId: "COLLECTION", statuses: ["ACTIVE"] },
      expected: (truth) =>
        truth.filter((t) => summer(t) && t.status === "ACTIVE").length,
    },
    {
      name: "collection + price + status ACTIVE",
      filters: {
        collectionId: "COLLECTION",
        priceMin: "10",
        priceMax: "20",
        statuses: ["ACTIVE"],
      },
      expected: (truth) =>
        truth.filter(
          (t) =>
            summer(t) && t.status === "ACTIVE" && inRange(t.prices, 10, 20),
        ).length,
    },
    {
      name: "collection + sku prefix",
      filters: { collectionId: "COLLECTION", skuPrefix: "AMD-HOO" },
      expected: (truth) =>
        truth.filter((t) => summer(t) && t.productType === "Hoodie").length,
    },
    {
      name: "collection + search 'Hoodie'",
      filters: { collectionId: "COLLECTION", search: "Hoodie" },
      expected: (truth) =>
        truth.filter((t) => summer(t) && t.title.includes("Hoodie")).length,
    },
  ];
}

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

async function main() {
  loadEnvFile();
  const shop = process.env.SEED_SHOP_DOMAIN;
  const token = process.env.SEED_ADMIN_TOKEN;
  if (!shop || !token) {
    console.error("Set SEED_SHOP_DOMAIN and SEED_ADMIN_TOKEN in .env.");
    process.exit(1);
  }

  const admin = stubAdmin(shop, token);
  const response = await admin.graphql(
    `{ collections(first: 250) { nodes { id title } } }`,
  );
  const { data } = (await response.json()) as {
    data: { collections: { nodes: { id: string; title: string }[] } };
  };
  const collection = data.collections.nodes.find(
    (node) => node.title === COLLECTIONS[0],
  );
  if (!collection) throw new Error(`No "${COLLECTIONS[0]}" collection — seed first.`);

  const truth = groundTruth();
  let failures = 0;

  for (const testCase of buildCases(0)) {
    const filters: SelectFilters = {
      ...emptyFilters(),
      ...testCase.filters,
      collectionId:
        testCase.filters.collectionId === "COLLECTION" ? collection.id : "",
    };
    const page = await fetchProductPage(admin, {
      filters,
      sortKey: "TITLE",
      reverse: false,
      cursor: null,
      direction: "next",
    });

    const expected = testCase.expected(truth);
    const ok = page.totalProducts === expected && !page.totalIsLowerBound;
    if (!ok) failures += 1;
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${String(page.totalProducts).padStart(5)} ` +
        `(expected ${String(expected).padStart(5)})  ${testCase.name}`,
    );
    if (!ok) console.log(`        query: ${page.query}`);
  }

  // Pagination over the scanned path has to cover every match exactly once.
  // `inventoryMin` is a residual term that matches everything, so this pages
  // the whole collection rather than the single page 49 rows would fit on.
  const filters: SelectFilters = {
    ...emptyFilters(),
    collectionId: collection.id,
    inventoryMin: "0",
  };
  const seen = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    const page = await fetchProductPage(admin, {
      filters,
      sortKey: "TITLE",
      reverse: false,
      cursor,
      direction: "next",
    });
    for (const id of page.rowIds) {
      if (seen.has(id)) throw new Error(`Duplicate row across pages: ${id}`);
      seen.add(id);
    }
    pages += 1;
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
    if (pages > 20) throw new Error("Pagination did not terminate.");
  }
  const paged = seen.size;
  const expectedPaged = truth.filter((t) => t.collections.includes(0)).length;
  const pagedOk = paged === expectedPaged;
  if (!pagedOk) failures += 1;
  console.log(
    `${pagedOk ? "PASS" : "FAIL"}  ${String(paged).padStart(5)} ` +
      `(expected ${String(expectedPaged).padStart(5)})  paginated over ${pages} pages, no duplicates`,
  );

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`\nVerification failed: ${(error as Error).message}`);
  process.exit(1);
});
