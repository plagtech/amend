/**
 * Runs a real bulk edit against the seeded dev store, through the real engine,
 * and checks the store itself before, after apply, and after undo.
 *
 * `verify-filters.ts` proves the diff arithmetic is right. This proves the part
 * arithmetic cannot: that what the preview promised is what landed in the
 * catalog, and that undo puts every byte of it back. The store is read directly
 * from Shopify at each of the three points — never from our own snapshot rows —
 * because a snapshot agreeing with itself proves nothing.
 *
 *   npm run verify:apply           # the inline path: ~6 products, seconds
 *   npm run verify:apply -- --bulk # the Bulk Operations path: ~100, minutes
 *
 * It calls `createApplyJob` / `runJob` / `createUndoJob` — the same functions
 * the routes call — so a regression in the engine fails here rather than in a
 * merchant's catalog. It writes to the store and then reverses itself; run it
 * against a dev store only.
 *
 * Assumes `npm run seed` has been run and the catalog is unedited.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import type { EditJob } from "@prisma/client";

import db from "../app/db.server";
import type { EditAction } from "../app/lib/actions";
import { nextPrice, nextTags } from "../app/lib/actions";
import {
  createApplyJob,
  createUndoJob,
  reconcileBulkJob,
  runJob,
} from "../app/lib/apply.server";
import { emptyFilters } from "../app/lib/filters";
import { isTerminal, jobName } from "../app/lib/jobs";
import type { JobScope } from "../app/lib/snapshots.server";
import { collectMatchingProducts } from "../app/lib/products.server";
import { sleep } from "../app/lib/throttle.server";
import type { Selection } from "../app/lib/use-selection";

/** Keep in step with `ApiVersion.July26` in `app/shopify.server.ts`. */
const API_VERSION = "2026-07";

/**
 * The scan each mode is scoped to.
 *
 * Inline: Hoodies numbered 0001–0099, a dozen or so products, of which six are
 * edited — at four changed rows each that stays under `SYNC_ITEM_LIMIT`.
 * Bulk: every Hoodie, roughly a hundred products and four hundred rows, which
 * is comfortably over it.
 */
const INLINE_SKU_PREFIX = "AMD-HOO-00";
const BULK_SKU_PREFIX = "AMD-HOO-0";

/** Products edited in inline mode. */
const INLINE_TARGET = 6;

/** Products held back as a control in bulk mode. */
const BULK_CONTROL = 2;

/** A tag no seeded product carries, so "was it added?" has one clear answer. */
const VERIFY_TAG = "amend-verify";

/** Shopify schedules bulk operations on its own time; this is the patience budget. */
const BULK_TIMEOUT_MS = 10 * 60 * 1000;
const BULK_POLL_MS = 5_000;

const EDIT: EditAction[] = [
  {
    type: "price",
    field: "price",
    op: "decrease",
    unit: "percent",
    amount: "15",
    rounding: "end99",
  },
  { type: "tags", op: "add", tags: [VERIFY_TAG] },
];

const PRICE_EDIT = EDIT[0] as Extract<EditAction, { type: "price" }>;
const TAG_EDIT = EDIT[1] as Extract<EditAction, { type: "tags" }>;

// --- harness ----------------------------------------------------------------

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    ok
      ? `PASS  ${label}`
      : `FAIL  ${label}` +
          `\n        got      ${truncate(actual)}` +
          `\n        expected ${truncate(expected)}`,
  );
}

function assertTrue(label: string, condition: boolean): void {
  check(label, condition, true);
}

/** Whole-catalog fingerprints are long; a failure needs a readable head of one. */
function truncate(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

function loadEnvFile(): void {
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

/**
 * An `AdminApiContext` backed by the seed token.
 *
 * The engine takes its admin context as an argument precisely so this is
 * possible: the whole apply/undo path can be driven with an Admin API token and
 * no app installation, session, or tunnel.
 */
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

// --- reading the store ------------------------------------------------------

interface StoreVariant {
  id: string;
  price: string;
  compareAtPrice: string | null;
}

interface StoreProduct {
  id: string;
  status: string;
  tags: string[];
  variants: StoreVariant[];
}

const STATE_QUERY = `#graphql
  query VerifyState($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        status
        tags
        variants(first: 25) {
          nodes {
            id
            price
            compareAtPrice
          }
        }
      }
    }
  }
`;

/** Products per state read. Keeps the nested variant cost well inside budget. */
const STATE_CHUNK = 40;

/**
 * The catalog's own account of these products, read fresh from Shopify.
 *
 * Tags are sorted because Shopify returns them in its own order — the
 * assertions are about which tags exist, not about an ordering Shopify owns.
 */
async function readStore(
  admin: AdminApiContext,
  ids: string[],
): Promise<Map<string, StoreProduct>> {
  const state = new Map<string, StoreProduct>();

  for (let i = 0; i < ids.length; i += STATE_CHUNK) {
    const response = await admin.graphql(STATE_QUERY, {
      variables: { ids: ids.slice(i, i + STATE_CHUNK) },
    });
    const body = (await response.json()) as {
      data?: {
        nodes: ({
          id: string;
          status: string;
          tags: string[];
          variants: { nodes: StoreVariant[] };
        } | null)[];
      };
      errors?: { message: string }[];
    };
    if (body.errors?.length || !body.data) {
      throw new Error(
        `Reading the store failed: ${
          body.errors?.map((error) => error.message).join("; ") ?? "no data"
        }`,
      );
    }

    for (const node of body.data.nodes) {
      if (!node) continue;
      state.set(node.id, {
        id: node.id,
        status: node.status,
        tags: [...node.tags].sort(),
        variants: node.variants.nodes
          .map((variant) => ({
            id: variant.id,
            // Shopify normalises "0.00" to "0.0" and back; compare in cents.
            price: money(variant.price),
            compareAtPrice:
              variant.compareAtPrice === null
                ? null
                : money(variant.compareAtPrice),
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      });
    }
  }

  return state;
}

function money(value: string): string {
  return (Math.round(Number.parseFloat(value) * 100) / 100).toFixed(2);
}

/** Comparable form of a store slice, so one check covers every field of it. */
function fingerprint(
  state: Map<string, StoreProduct>,
  ids?: string[],
): unknown {
  const wanted = ids ?? [...state.keys()];
  return [...wanted]
    .sort()
    .map((id) => state.get(id) ?? { id, missing: true });
}

/** What the store should look like once `EDIT` has been applied to `selected`. */
function expectedAfterApply(
  before: Map<string, StoreProduct>,
  selectedIds: Set<string>,
  tagsExcludedFor: string,
): Map<string, StoreProduct> {
  const after = new Map<string, StoreProduct>();

  for (const [id, product] of before) {
    if (!selectedIds.has(id)) {
      after.set(id, product);
      continue;
    }
    after.set(id, {
      ...product,
      tags:
        id === tagsExcludedFor
          ? product.tags
          : [...nextTags(product.tags, TAG_EDIT)].sort(),
      variants: product.variants.map((variant) => ({
        ...variant,
        price: nextPrice(variant.price, PRICE_EDIT) ?? variant.price,
      })),
    });
  }

  return after;
}

// --- driving a job to the end ----------------------------------------------

/**
 * Run a job and wait for it to reach a terminal state.
 *
 * An inline job is already finished when `runJob` returns. A bulk job is not —
 * it is waiting on `bulk_operations/finish`, which a script has no way to
 * receive, so this polls `reconcileBulkJob` instead. That is not a shortcut
 * around the real path: it is exactly what the stale sweep does in production
 * when a webhook goes missing, so exercising it here covers both.
 */
async function runToCompletion(
  admin: AdminApiContext,
  jobId: string,
): Promise<EditJob> {
  await runJob(admin, jobId);

  const deadline = Date.now() + BULK_TIMEOUT_MS;
  let announced: string | null = null;

  for (;;) {
    const job = await db.editJob.findUnique({ where: { id: jobId } });
    if (!job) throw new Error(`Job ${jobId} disappeared mid-run.`);
    if (isTerminal(job.status)) return job;

    if (Date.now() > deadline) {
      throw new Error(
        `Job ${jobId} was still "${job.status}" after ${BULK_TIMEOUT_MS / 1000}s.`,
      );
    }

    const phase = `${job.status}${job.stage ? ` (${job.stage} stage)` : ""}`;
    if (phase !== announced) {
      console.log(`      … ${phase}`);
      announced = phase;
    }

    if (job.bulkOpGid && job.stage) await reconcileBulkJob(admin, job);
    await sleep(BULK_POLL_MS);
  }
}

// --- the run ----------------------------------------------------------------

async function main(): Promise<void> {
  loadEnvFile();
  const bulk = process.argv.includes("--bulk");
  const shop = process.env.SEED_SHOP_DOMAIN;
  const token = process.env.SEED_ADMIN_TOKEN;
  if (!shop || !token) {
    console.error("Set SEED_SHOP_DOMAIN and SEED_ADMIN_TOKEN in .env.");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("Set DATABASE_URL in .env — the job engine needs Postgres.");
    process.exit(1);
  }

  const admin = stubAdmin(shop, token);
  const created: string[] = [];

  try {
    // --- pick a scope ------------------------------------------------------
    const filters = {
      ...emptyFilters(),
      skuPrefix: bulk ? BULK_SKU_PREFIX : INLINE_SKU_PREFIX,
    };
    const { products, truncated } = await collectMatchingProducts(admin, {
      filters,
      sortKey: "TITLE",
      reverse: false,
      includeVariants: false,
    });
    if (truncated) throw new Error("The scan was truncated — narrow the scope.");

    const inScope = products.map((product) => product.id);
    const minimum = bulk ? BULK_CONTROL + 20 : INLINE_TARGET + 1;
    if (inScope.length < minimum) {
      throw new Error(
        `Only ${inScope.length} products match ${filters.skuPrefix} — seed the store first.`,
      );
    }

    // Products the filter matched but the selection leaves out. A bulk editor
    // that edits one product too many is worse than one that edits none, so
    // this control is asserted unchanged at every step.
    const selectedIds = bulk
      ? inScope.slice(0, inScope.length - BULK_CONTROL)
      : inScope.slice(0, INLINE_TARGET);
    const untouchedIds = inScope.filter((id) => !selectedIds.includes(id));

    // The same shape either way: in inline mode the merchant ticked rows, in
    // bulk mode they used "select all matching" and unticked a couple.
    const selection: Selection = bulk
      ? { mode: "all", excluded: untouchedIds }
      : { mode: "some", ids: selectedIds };

    console.log(
      `Mode: ${bulk ? "Bulk Operations" : "inline"} · ${inScope.length} products match ` +
        `${filters.skuPrefix} · editing ${selectedIds.length}, holding ${untouchedIds.length} back\n`,
    );

    const before = await readStore(admin, inScope);
    const beforePrint = fingerprint(before, inScope);

    // Reset usage so a re-run isn't refused by the free tier's job allowance.
    await db.shop.upsert({
      where: { id: shop },
      create: { id: shop, plan: "free" },
      update: { plan: "free", jobsThisMonth: 0, cycleStart: new Date() },
    });

    // --- invariant: no mutation without a complete snapshot ----------------
    console.log("Invariant — a job whose snapshots are missing refuses to write:");
    const tampered = await db.editJob.create({
      data: {
        shopId: shop,
        name: "verify: tampered job",
        status: "queued",
        // Claims to have snapshotted 5 rows and has none. The gate in
        // `mutatePhase` is the only thing between this and a write.
        totalItems: 5,
        filterJson: {},
        actionsJson: EDIT as never,
      },
    });
    created.push(tampered.id);
    await runJob(admin, tampered.id);
    const tamperedAfter = await db.editJob.findUnique({
      where: { id: tampered.id },
    });
    check("refused, job marked failed", tamperedAfter?.status, "failed");
    assertTrue(
      "refusal names the missing snapshots",
      (tamperedAfter?.error ?? "").includes("Refusing to mutate"),
    );
    check(
      "the store was not touched",
      fingerprint(await readStore(admin, inScope), inScope),
      beforePrint,
    );

    // --- invariant: one running job per shop -------------------------------
    console.log("\nInvariant — a second job waits for the shop's run slot:");
    const blocker = await db.editJob.create({
      data: {
        shopId: shop,
        name: "verify: occupying the slot",
        status: "running",
        heartbeatAt: new Date(),
        filterJson: {},
        actionsJson: EDIT as never,
      },
    });
    const waiter = await db.editJob.create({
      data: {
        shopId: shop,
        name: "verify: should stay queued",
        status: "queued",
        filterJson: {},
        actionsJson: EDIT as never,
      },
    });
    await runJob(admin, waiter.id);
    check(
      "second job stayed queued",
      (await db.editJob.findUnique({ where: { id: waiter.id } }))?.status,
      "queued",
    );
    await db.editJob.deleteMany({
      where: { id: { in: [blocker.id, waiter.id] } },
    });

    // --- apply -------------------------------------------------------------
    console.log("\nApply — a real edit through the real engine:");
    // One product's tag row is excluded, so per-row exclusion is proven to
    // survive into the write and not just the preview: its prices must move,
    // its tags must not.
    const excludedProduct = selectedIds[selectedIds.length - 1];
    const scope: JobScope = {
      filters,
      selection,
      excluded: [excludedProduct],
      sortKey: "TITLE",
      reverse: false,
    };

    // The key the browser would have received with its preview.
    const applyKey = randomUUID();
    const job = await createApplyJob({
      shopId: shop,
      name: jobName(EDIT, "verify"),
      scope,
      actions: EDIT,
      idempotencyKey: applyKey,
    });
    created.push(job.id);
    const applied = await runToCompletion(admin, job.id);

    const rows = await db.snapshot.findMany({ where: { jobId: job.id } });
    // Three price rows per product, plus one tag row for every product except
    // the one whose tag row was excluded.
    const expectedRows = selectedIds.length * 3 + (selectedIds.length - 1);

    check("job completed", applied.status, "completed");
    check("took the expected path", applied.mode, bulk ? "bulk" : "sync");
    check("no failures", applied.failedItems, 0);
    check("snapshot rows", rows.length, expectedRows);
    check("job.totalItems matches the snapshot", applied.totalItems, rows.length);
    check(
      "every row applied",
      rows.filter((row) => row.applied).length,
      expectedRows,
    );
    assertTrue(
      "every variant row recorded its parent product",
      rows
        .filter((row) => row.fieldPath.startsWith("variant."))
        .every((row) => Boolean(row.productGid)),
    );
    check(
      "the apply consumed one job credit",
      (await db.shop.findUnique({ where: { id: shop } }))?.jobsThisMonth,
      1,
    );

    console.log("\nStore state after apply:");
    const afterApply = await readStore(admin, inScope);
    const expectedOnce = fingerprint(
      expectedAfterApply(before, new Set(selectedIds), excludedProduct),
      inScope,
    );
    check(
      "catalog matches the edit exactly",
      fingerprint(afterApply, inScope),
      expectedOnce,
    );
    assertTrue(
      "the excluded row kept its tags while its prices still moved",
      !afterApply.get(excludedProduct)!.tags.includes(VERIFY_TAG) &&
        afterApply
          .get(excludedProduct)!
          .variants.some(
            (variant, i) =>
              variant.price !== before.get(excludedProduct)!.variants[i].price,
          ),
    );
    check(
      "unselected products in the same filter were untouched",
      fingerprint(afterApply, untouchedIds),
      fingerprint(before, untouchedIds),
    );

    // --- idempotency: the confirm POST arrives twice -----------------------
    // The failure this exists to prevent is not a wasted call. A second job
    // would re-resolve the selection against the catalog the first one already
    // discounted, take another 15% off, and record the discounted price as its
    // before-value — leaving a catalog that needs two undos, in the right
    // order, to recover. So this asserts the store, not just the row count.
    console.log("\nIdempotency — the same confirm POST, replayed:");
    const replay = await createApplyJob({
      shopId: shop,
      name: jobName(EDIT, "verify"),
      scope,
      actions: EDIT,
      idempotencyKey: applyKey,
    });
    // The route fires this after every apply, replay or not.
    await runJob(admin, replay.id);

    check("the replay resolved to the original job", replay.id, job.id);
    check(
      "exactly one job exists for the key",
      await db.editJob.count({
        where: { shopId: shop, idempotencyKey: applyKey },
      }),
      1,
    );
    check(
      "no second job was queued behind it",
      await db.editJob.count({
        where: {
          shopId: shop,
          status: { in: ["queued", "snapshotting", "running"] },
        },
      }),
      0,
    );
    check(
      "the replay consumed no second credit",
      (await db.shop.findUnique({ where: { id: shop } }))?.jobsThisMonth,
      1,
    );
    check(
      "no second snapshot set was written",
      await db.snapshot.count({ where: { jobId: job.id } }),
      expectedRows,
    );
    check(
      "the catalog still shows one application, not two",
      fingerprint(await readStore(admin, inScope), inScope),
      expectedOnce,
    );

    // --- undo --------------------------------------------------------------
    console.log("\nUndo:");
    const undo = await createUndoJob(shop, job.id);
    created.push(undo.id);
    const undone = await runToCompletion(admin, undo.id);
    const undoRows = await db.snapshot.findMany({ where: { jobId: undo.id } });

    check("undo completed", undone.status, "completed");
    check("undo had no failures", undone.failedItems, 0);
    check("undo covers every applied row", undoRows.length, expectedRows);
    check(
      "undo applied every row",
      undoRows.filter((row) => row.applied).length,
      expectedRows,
    );
    check("nothing had drifted", undoRows.filter((row) => row.drifted).length, 0);
    check(
      "undo is free — no job credit consumed",
      (await db.shop.findUnique({ where: { id: shop } }))?.jobsThisMonth,
      1,
    );
    check(
      "the original job is marked undone",
      (await db.editJob.findUnique({ where: { id: job.id } }))?.status,
      "undone",
    );
    check("the undo links back to it", undone.undoOfJobId, job.id);

    console.log("\nStore state after undo:");
    check(
      "catalog is byte-for-byte what it was before the edit",
      fingerprint(await readStore(admin, inScope), inScope),
      beforePrint,
    );
  } finally {
    // The catalog restores itself via undo; the job rows are this script's
    // litter and would otherwise pile up in the merchant-facing history.
    if (created.length) {
      await db.snapshot.deleteMany({ where: { jobId: { in: created } } });
      await db.editJob.deleteMany({ where: { id: { in: created } } });
    }
    await db.shop.updateMany({
      where: { id: process.env.SEED_SHOP_DOMAIN ?? "" },
      data: { jobsThisMonth: 0 },
    });
    await db.$disconnect();
  }

  console.log(
    failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(`\nVerification failed: ${(error as Error).message}`);
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
