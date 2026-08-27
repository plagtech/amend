/**
 * Proves a scheduled edit runs on its own.
 *
 *   npm run verify:schedule
 *
 * The point of this script is what it does *not* do: it never calls a loader,
 * never opens a page, and never touches the engine after creating the job. It
 * starts the same `startScheduler()` the web server starts, then waits. If the
 * catalog changes, it changed because a timer fired — which is the whole claim
 * Phase 6 makes.
 *
 * It also covers the three things that make scheduling safe rather than merely
 * possible: a scheduled job spends no credit until it fires, one that fires
 * over the allowance fails loudly instead of silently, and a cancelled schedule
 * stays cancelled. The auto-revert (`revertAt`) is exercised the same way —
 * fired by the timer, asserted against the store.
 *
 * Writes to the seed store and reverses itself. Dev stores only.
 */

import { randomUUID } from "node:crypto";
import process from "node:process";

import type { EditJob } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

import db from "../app/db.server";
import type { EditAction } from "../app/lib/actions";
import { emptyMatch, nextTags } from "../app/lib/actions";
import { cancelScheduledJob, createApplyJob } from "../app/lib/apply.server";
import { emptyFilters } from "../app/lib/filters";
import { FREE_JOB_LIMIT, isTerminal } from "../app/lib/jobs";
import { collectMatchingProducts } from "../app/lib/products.server";
import { startScheduler, stopScheduler } from "../app/lib/scheduler.server";
import type { JobScope } from "../app/lib/snapshots.server";
import {
  assertTrue,
  check,
  report,
  requireSeedEnv,
  sleep,
  stubAdmin,
} from "./harness";

/** Two products is plenty: this script is about timing, not about scale. */
const SKU_PREFIX = "AMD-CAP-00";
const TARGET_PRODUCTS = 2;

/** A tag no seeded product carries, so "did it run?" has one clear answer. */
const VERIFY_TAG = "amend-schedule-verify";

/** Ticks are 2s here; in the server they are 30s. */
const TICK_MS = 2_000;

/** How long to wait for a timer-driven transition before calling it broken. */
const WAIT_MS = 120_000;

const EDIT: EditAction[] = [
  { type: "tags", op: "add", tags: [VERIFY_TAG], match: emptyMatch() },
];

async function main(): Promise<void> {
  const { shop, token } = requireSeedEnv();
  // The scheduler resolves an admin client per shop; in the server that is the
  // stored offline token, here it is the seed token. Everything else — the
  // promotion, the credit, the engine, the undo — is the production path.
  const admin = stubAdmin(shop, token);
  const adminFor = async () => admin;

  process.env.SCHEDULER_TICK_MS = String(TICK_MS);
  delete process.env.SCHEDULER_DISABLED;

  const created: string[] = [];

  try {
    const { products } = await collectMatchingProducts(admin, {
      filters: { ...emptyFilters(), skuPrefix: SKU_PREFIX },
      sortKey: "TITLE",
      reverse: false,
      includeVariants: false,
    });
    const ids = products.slice(0, TARGET_PRODUCTS).map((product) => product.id);
    if (ids.length < TARGET_PRODUCTS) {
      throw new Error(
        `Only ${ids.length} products match ${SKU_PREFIX} — seed the store first.`,
      );
    }

    const scope: JobScope = {
      filters: { ...emptyFilters(), skuPrefix: SKU_PREFIX },
      selection: { mode: "some", ids },
      excluded: [],
      sortKey: "TITLE",
      reverse: false,
    };

    const before = await readTags(admin, ids);
    await resetShop(shop, 0);

    // --- a job that runs itself -------------------------------------------
    console.log("Scheduling — a job set for the near future, then nobody looks:");
    const runAt = new Date(Date.now() + 4_000);
    const revertAt = new Date(Date.now() + 45_000);
    const job = await createApplyJob({
      shopId: shop,
      name: "verify: scheduled edit",
      scope,
      actions: EDIT,
      idempotencyKey: randomUUID(),
      scheduledFor: runAt,
      revertAt,
    });
    created.push(job.id);

    check("the job is scheduled, not queued", job.status, "scheduled");
    check("it recorded when to run", job.scheduledFor?.toISOString(), runAt.toISOString());
    check("no credit was spent up front", await creditsUsed(shop), 0);
    check(
      "and nothing was written to the catalog",
      await readTags(admin, ids),
      before,
    );

    // From here on, this script does nothing but wait.
    startScheduler({ adminFor });
    console.log(`      … scheduler started (${TICK_MS}ms ticks), waiting`);

    const ran = await waitForJob(job.id, (row) => isTerminal(row.status));
    check("the timer ran it to completion", ran.status, "completed");
    check("the credit was spent when it fired", await creditsUsed(shop), 1);
    check("no failures", ran.failedItems, 0);

    const afterApply = await readTags(admin, ids);
    check(
      "the catalog changed, with no page open and no webhook",
      afterApply,
      Object.fromEntries(
        Object.entries(before).map(([id, tags]) => [
          id,
          [...nextTags(tags, EDIT[0] as never)].sort(),
        ]),
      ),
    );

    // --- the sale window closes itself ------------------------------------
    console.log("\nAuto-revert — the same timer, undoing it at revertAt:");
    const undone = await waitForJob(job.id, (row) => row.status === "undone");
    check("the original job is marked undone", undone.status, "undone");

    const undoJob = await db.editJob.findFirst({
      where: { shopId: shop, undoOfJobId: job.id },
    });
    if (undoJob) created.push(undoJob.id);
    assertTrue("an undo job was created for it", Boolean(undoJob));
    check("the undo completed", undoJob?.status, "completed");
    check(
      "the catalog is back to what it was",
      await readTags(admin, ids),
      before,
    );
    check("the undo consumed no credit", await creditsUsed(shop), 1);
    check(
      "revertAt was cleared, so it cannot fire twice",
      (await db.editJob.findUnique({ where: { id: job.id } }))?.revertAt ?? null,
      null,
    );

    // --- a schedule the merchant calls off ---------------------------------
    console.log("\nCancelling — a scheduled job stopped before it fires:");
    const doomed = await createApplyJob({
      shopId: shop,
      name: "verify: cancelled schedule",
      scope,
      actions: EDIT,
      idempotencyKey: randomUUID(),
      scheduledFor: new Date(Date.now() + 3_000),
    });
    created.push(doomed.id);
    const cancelled = await cancelScheduledJob(shop, doomed.id);
    check("it is cancelled", cancelled.status, "cancelled");

    // Long enough for several ticks to pass over it.
    await sleep(TICK_MS * 3);
    check(
      "and the timer left it alone",
      (await db.editJob.findUnique({ where: { id: doomed.id } }))?.status,
      "cancelled",
    );
    check("cancelling spent no credit", await creditsUsed(shop), 1);
    check(
      "the catalog was not touched",
      await readTags(admin, ids),
      before,
    );

    // --- firing with no allowance left -------------------------------------
    console.log("\nQuota at fire time — a scheduled job that fires over the limit:");
    const overQuota = await createApplyJob({
      shopId: shop,
      name: "verify: scheduled over quota",
      scope,
      actions: EDIT,
      idempotencyKey: randomUUID(),
      scheduledFor: new Date(Date.now() + 2_000),
    });
    created.push(overQuota.id);
    // Spend the allowance *after* scheduling — exactly the case the quota check
    // at fire time exists for.
    await resetShop(shop, FREE_JOB_LIMIT);

    const refused = await waitForJob(overQuota.id, (row) =>
      isTerminal(row.status),
    );
    check("it failed rather than running", refused.status, "failed");
    assertTrue(
      "and said why, in the job's own error",
      (refused.error ?? "").includes(`all ${FREE_JOB_LIMIT} bulk edits`),
    );
    check(
      "the catalog is still untouched",
      await readTags(admin, ids),
      before,
    );
  } finally {
    stopScheduler();
    if (created.length) {
      await db.snapshot.deleteMany({ where: { jobId: { in: created } } });
      await db.editJob.deleteMany({ where: { id: { in: created } } });
    }
    await resetShop(process.env.SEED_SHOP_DOMAIN ?? "", 0);
    await db.$disconnect();
  }

  report();
}

async function resetShop(shopId: string, jobsThisMonth: number): Promise<void> {
  if (!shopId) return;
  await db.shop.upsert({
    where: { id: shopId },
    create: { id: shopId, plan: "free", jobsThisMonth, cycleStart: new Date() },
    update: { plan: "free", jobsThisMonth, cycleStart: new Date() },
  });
}

async function creditsUsed(shopId: string): Promise<number> {
  return (
    (await db.shop.findUnique({ where: { id: shopId } }))?.jobsThisMonth ?? 0
  );
}

/** Poll the job row — the only thing this script does while it waits. */
async function waitForJob(
  jobId: string,
  done: (job: EditJob) => boolean,
): Promise<EditJob> {
  const deadline = Date.now() + WAIT_MS;
  let announced: string | null = null;

  for (;;) {
    const job = await db.editJob.findUnique({ where: { id: jobId } });
    if (!job) throw new Error(`Job ${jobId} disappeared.`);
    if (done(job)) return job;
    if (Date.now() > deadline) {
      throw new Error(
        `Job ${jobId} was still "${job.status}" after ${WAIT_MS / 1000}s.`,
      );
    }
    if (job.status !== announced) {
      console.log(`      … ${job.status}`);
      announced = job.status;
    }
    await sleep(1_000);
  }
}

const TAGS_QUERY = `#graphql
  query VerifyTags($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        tags
      }
    }
  }
`;

/** The store's own account of these products' tags, read fresh. */
async function readTags(
  admin: AdminApiContext,
  ids: string[],
): Promise<Record<string, string[]>> {
  const response = await admin.graphql(TAGS_QUERY, { variables: { ids } });
  const body = (await response.json()) as {
    data?: { nodes: ({ id: string; tags: string[] } | null)[] };
    errors?: { message: string }[];
  };
  if (body.errors?.length || !body.data) {
    throw new Error(
      `Reading the store failed: ${
        body.errors?.map((error) => error.message).join("; ") ?? "no data"
      }`,
    );
  }

  const tags: Record<string, string[]> = {};
  for (const node of body.data.nodes) {
    if (node) tags[node.id] = [...node.tags].sort();
  }
  return tags;
}

main().catch(async (error) => {
  console.error(`\nVerification failed: ${(error as Error).message}`);
  stopScheduler();
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
