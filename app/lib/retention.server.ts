/**
 * Snapshot retention (SPEC §4, §7): a finished job's before-values are kept
 * for 90 days on Free and 365 on Pro, then deleted.
 *
 * ## What is deleted, and what is not
 *
 * Only `Snapshot` rows — the before/after values that make undo possible. The
 * job row stays, with `snapshotsPrunedAt` set, so history still shows the edit
 * and the app can say **"undo expired"** rather than quietly dropping the Undo
 * button (the buttons and the job page's counts are computed from the rows
 * this deletes). The edit itself, in the merchant's catalog, is untouched.
 *
 * The window is measured from when the job finished, against the shop's plan
 * *at sweep time*: a downgrade from Pro shortens it for jobs already older
 * than 90 days, and an upgrade lengthens it for anything not yet deleted.
 *
 * ## What is never pruned
 *
 *   - a job that has not finished (`queued`, `snapshotting`, `running`,
 *     `scheduled`) — its snapshots are its before-picture, still in use;
 *   - a job with a pending auto-revert (`revertAt` set) — the scheduler will
 *     need those rows to undo it;
 *   - a job whose undo is in flight — that undo reads these rows.
 *
 * ## The claim
 *
 * Like every other sweep in the scheduler, this is safe to run from two
 * places at once. Each job is pruned in one transaction that first takes a
 * row lock on the job (`SELECT … FOR UPDATE`) and re-checks every condition
 * above under it, then stamps `snapshotsPrunedAt` and deletes the rows.
 * `createUndoJob` takes the same lock before it creates an undo, so the two
 * are mutually exclusive: either the undo exists first and the prune skips
 * the job, or the prune commits first and the undo is refused as expired.
 * Neither can produce an undo job with nothing to restore.
 */

import type { Prisma } from "@prisma/client";

import db from "../db.server";
import { SNAPSHOT_RETENTION_DAYS } from "./jobs";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Statuses whose snapshots are history rather than work in progress. */
const FINISHED = ["completed", "failed", "undone"];

/** An undo in one of these is reading the original job's snapshots. */
const IN_FLIGHT = ["queued", "snapshotting", "running", "scheduled"];

/** Jobs examined per batch, and batches per pass — a backlog drains over passes. */
const PRUNE_BATCH = 50;
const PRUNE_MAX_BATCHES = 10;

/** The scheduler ticks every 30s; retention is measured in days. */
const PRUNE_EVERY_MS = 60 * 60 * 1000;
let lastPruneAt = 0;

export interface PruneResult {
  /** Jobs whose snapshots were deleted in this pass. */
  jobs: number;
  /** Snapshot rows deleted. */
  snapshots: number;
}

function cutoffs(now: Date) {
  return {
    free: new Date(now.getTime() - SNAPSHOT_RETENTION_DAYS.free * DAY_MS),
    pro: new Date(now.getTime() - SNAPSHOT_RETENTION_DAYS.pro * DAY_MS),
  };
}

/**
 * Called from every scheduler tick; does real work at most once an hour per
 * process. Two processes may both run it — the per-job claim makes that safe.
 */
export async function maybePruneSnapshots(now = new Date()): Promise<number> {
  if (now.getTime() - lastPruneAt < PRUNE_EVERY_MS) return 0;
  lastPruneAt = now.getTime();
  return (await pruneExpiredSnapshots({ now })).jobs;
}

/**
 * One full pass. Exported for `scripts/verify-retention.ts`, which passes
 * `now` and `shopIds` so it can age its own jobs without touching anyone
 * else's.
 */
export async function pruneExpiredSnapshots({
  now = new Date(),
  shopIds,
}: { now?: Date; shopIds?: string[] } = {}): Promise<PruneResult> {
  const result: PruneResult = { jobs: 0, snapshots: 0 };

  for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch += 1) {
    const candidates = await findCandidates(now, shopIds);
    if (!candidates.length) break;

    let progressed = false;
    for (const { id } of candidates) {
      const deleted = await pruneJob(id, now);
      if (deleted === null) continue;
      progressed = true;
      result.jobs += 1;
      result.snapshots += deleted;
    }
    // Every candidate was skipped under the lock (an undo started, a plan
    // changed): the next query would return the same rows. Stop.
    if (!progressed || candidates.length < PRUNE_BATCH) break;
  }

  return result;
}

async function findCandidates(
  now: Date,
  shopIds?: string[],
): Promise<{ id: string }[]> {
  const { free, pro } = cutoffs(now);
  const finished = FINISHED.map((status) => `'${status}'`).join(", ");
  const shopFilter = shopIds
    ? `AND j."shopId" = ANY($3::text[])`
    : "";
  // Raw SQL for the join: the window depends on the shop's plan, and
  // `EditJob.shopId` is not a Prisma relation.
  return db.$queryRawUnsafe<{ id: string }[]>(
    `SELECT j."id"
       FROM "EditJob" j
       LEFT JOIN "Shop" s ON s."id" = j."shopId"
      WHERE j."snapshotsPrunedAt" IS NULL
        AND j."status" IN (${finished})
        AND j."revertAt" IS NULL
        AND COALESCE(j."completedAt", j."createdAt") <
            CASE WHEN s."plan" = 'pro' THEN $1::timestamp ELSE $2::timestamp END
        ${shopFilter}
      ORDER BY COALESCE(j."completedAt", j."createdAt") ASC
      LIMIT ${PRUNE_BATCH}`,
    pro,
    free,
    ...(shopIds ? [shopIds] : []),
  );
}

/**
 * Prune one job under its row lock. Returns the number of rows deleted, or
 * null when the job no longer qualifies — which is a normal outcome, not an
 * error: another instance got there first, an undo started, the shop
 * upgraded.
 */
async function pruneJob(jobId: string, now: Date): Promise<number | null> {
  const { free, pro } = cutoffs(now);

  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    const [job] = await tx.$queryRaw<
      {
        shopId: string;
        status: string;
        revertAt: Date | null;
        snapshotsPrunedAt: Date | null;
        finishedAt: Date;
      }[]
    >`SELECT "shopId", "status", "revertAt", "snapshotsPrunedAt",
             COALESCE("completedAt", "createdAt") AS "finishedAt"
        FROM "EditJob" WHERE "id" = ${jobId} FOR UPDATE`;

    if (!job || job.snapshotsPrunedAt || job.revertAt) return null;
    if (!FINISHED.includes(job.status)) return null;

    // Re-read under the lock: the plan may have changed since the candidate
    // query, and an upgrade must never cost a merchant an undo it now has.
    const shop = await tx.shop.findUnique({
      where: { id: job.shopId },
      select: { plan: true },
    });
    const cutoff = shop?.plan === "pro" ? pro : free;
    if (job.finishedAt >= cutoff) return null;

    const undoInFlight = await tx.editJob.count({
      where: { undoOfJobId: jobId, status: { in: IN_FLIGHT } },
    });
    if (undoInFlight > 0) return null;

    await tx.editJob.update({
      where: { id: jobId },
      data: { snapshotsPrunedAt: now },
    });
    const { count } = await tx.snapshot.deleteMany({ where: { jobId } });
    return count;
  });
}
