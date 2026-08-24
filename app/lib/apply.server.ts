/**
 * The job engine: snapshot, then mutate, then be undoable.
 *
 * ## The invariant
 *
 * Not one mutation runs until every snapshot row for the job is committed.
 * It is enforced structurally rather than by discipline: the snapshot write and
 * the `snapshotting → running` transition are the same database transaction,
 * and `mutatePhase` refuses to send anything for a job that is not `running`
 * with a snapshot count matching `totalItems`. A crash halfway through writing
 * snapshots leaves a job that has written nothing and can be restarted from
 * scratch; there is no state in which a catalog has been changed and the
 * before-picture is incomplete. Undo integrity is the brand — SPEC §5.
 *
 * ## Two delivery paths
 *
 * Below `SYNC_ITEM_LIMIT` line-items the mutations run inline, batched and
 * rate-limit aware, and the job is done before the merchant's page reloads.
 * Above it the job stages a JSONL upload and hands the whole edit to Shopify's
 * Bulk Operations, resuming when `bulk_operations/finish` arrives. Both paths
 * build their calls from `mutations.ts`, so what they send is identical.
 *
 * ## Resumability
 *
 * Every row carries `applied`, so a worker that dies mid-job resumes without
 * double-applying: it simply picks up the rows that are still pending. A job
 * that stops touching `heartbeatAt` is treated as crashed and requeued, and a
 * bulk job whose webhook never arrived is reconciled by polling the operation.
 *
 * ## One job per shop
 *
 * Claiming the run slot is a serializable transaction, so two concurrent
 * applies cannot both start. The loser stays `queued` and is drained by
 * whichever job finishes first — which is what keeps undo semantics
 * comprehensible when a merchant clicks Apply twice.
 */

import { Prisma } from "@prisma/client";
import type { EditJob } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

import db from "../db.server";
import type { EditAction } from "./actions";
import { parseActions } from "./actions";
import { fetchBulkOperation, fetchBulkResults, startBulkStage } from "./bulk.server";
import {
  CYCLE_DAYS,
  FREE_JOB_LIMIT,
  SYNC_ITEM_LIMIT,
  VARIANTS_PER_MUTATION,
  undoJobName,
} from "./jobs";
import type { MutationStage, MutationUnit } from "./mutations";
import {
  MUTATION_STAGES,
  STAGE_MUTATION,
  buildUnits,
  readUserError,
  unaddressableIds,
} from "./mutations";
import type { JobScope, SnapshotDraft } from "./snapshots.server";
import {
  IncompleteScopeError,
  buildApplyDrafts,
  buildUndoDrafts,
  parseScope,
  serializeScope,
} from "./snapshots.server";
import { ThrottledAdmin } from "./throttle.server";

/** A job that has not touched its heartbeat in this long is treated as crashed. */
const STALE_MS = 3 * 60 * 1000;

/** Heartbeats are throttled to this, so a long job isn't a write storm. */
const HEARTBEAT_MS = 5_000;

/** Snapshot rows per INSERT. Keeps each statement inside Postgres's bind limit. */
const INSERT_CHUNK = 1_000;

/** Jobs one drain pass will run before handing back. A runaway-loop backstop. */
const MAX_DRAIN = 25;

/**
 * Attempts at the job-creation transaction before giving up.
 *
 * Only serialization failures are retried, and only a genuine tie produces one,
 * so this never spins on a real error.
 */
const CREATE_ATTEMPTS = 3;

export class PlanLimitError extends Error {}
export class JobRequestError extends Error {}

/**
 * The offline-token admin context for a shop.
 *
 * Imported lazily, not at module load, so the engine's own entry points stay
 * free of app configuration. That is what lets `scripts/verify-apply.ts` drive
 * this exact code against a seed store with nothing but an Admin API token —
 * the verification runs the real engine, not a copy of it.
 */
async function adminFor(shop: string): Promise<AdminApiContext> {
  const { unauthenticated } = await import("../shopify.server");
  const { admin } = await unauthenticated.admin(shop);
  return admin;
}

// --- creating jobs ----------------------------------------------------------

export interface CreateApplyJobArgs {
  shopId: string;
  name: string;
  scope: JobScope;
  actions: EditAction[];
  /**
   * The key minted with the preview this apply confirms.
   *
   * Required, because without one there is nothing to tell a duplicate POST
   * apart from a merchant deliberately applying the same edit twice — and
   * guessing wrong in either direction is a worse failure than refusing.
   */
  idempotencyKey: string;
}

/**
 * The confirm POST arrived twice for the same preview.
 *
 * Not an error: the merchant asked for one edit and gets one edit. The caller
 * hands back the original job's id and the browser lands on the same job page
 * it would have anyway, none the wiser.
 */
async function jobForKey(
  shopId: string,
  idempotencyKey: string,
): Promise<EditJob> {
  const existing = await db.editJob.findFirst({
    where: { shopId, idempotencyKey },
  });
  // Postgres blocks the second inserter until the first transaction resolves
  // and only then raises the violation, so by the time we are here the winner
  // has committed and this lookup cannot miss. If it somehow does, the honest
  // answer is to say so rather than to quietly start a second edit.
  if (!existing) {
    throw new JobRequestError(
      "That edit could not be confirmed. Run the preview again.",
    );
  }
  return existing;
}

/**
 * Accept an edit and put it in the queue, exactly once.
 *
 * Deliberately does no Shopify work: resolving the selection can take many
 * seconds on a large catalog, and the merchant should land on the job page
 * watching it happen rather than on a spinner waiting for a POST.
 *
 * Exactly once matters more here than the phrase usually implies. A duplicate
 * apply is not a wasted call — it re-resolves the selection against the catalog
 * the first one already changed, so a relative edit (price −10%) compounds, and
 * the duplicate's snapshot records the discounted price as the before-value.
 * Undo would then need two passes in the right order to get back. The unique
 * index on `idempotencyKey` is what makes that unreachable.
 */
export async function createApplyJob({
  shopId,
  name,
  scope,
  actions,
  idempotencyKey,
}: CreateApplyJobArgs): Promise<EditJob> {
  if (!actions.length) {
    throw new JobRequestError("Add at least one edit action before applying.");
  }
  if (!idempotencyKey) {
    throw new JobRequestError(
      "This preview is stale. Run the preview again before applying.",
    );
  }

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await createApplyJobOnce({
        shopId,
        name,
        scope,
        actions,
        idempotencyKey,
      });
    } catch (error) {
      // The unique index did its job. The credit increment shared a
      // transaction with the insert, so it rolled back too — a replayed apply
      // costs the merchant nothing.
      if (isPrismaError(error, "P2002")) {
        return jobForKey(shopId, idempotencyKey);
      }
      // Two confirms landing in the same instant is the one case that reaches
      // here, and under `Serializable` the loser is not always told it lost on
      // the unique index — it can simply be told to retry. Retrying is what
      // converts that into the violation above, which is the answer we want.
      if (isPrismaError(error, "P2034") && attempt < CREATE_ATTEMPTS) continue;
      throw error;
    }
  }
}

function isPrismaError(error: unknown, code: string): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === code
  );
}

function createApplyJobOnce({
  shopId,
  name,
  scope,
  actions,
  idempotencyKey,
}: CreateApplyJobArgs): Promise<EditJob> {
  return db.$transaction(
    async (tx) => {
      const shop = await tx.shop.upsert({
        where: { id: shopId },
        create: { id: shopId },
        update: {},
      });

      // The usage cycle rolls lazily — there is no cron, and a shop that
      // doesn't visit doesn't need one.
      const cycleEnd = new Date(shop.cycleStart);
      cycleEnd.setDate(cycleEnd.getDate() + CYCLE_DAYS);
      const rolled = cycleEnd <= new Date();
      const used = rolled ? 0 : shop.jobsThisMonth;

      if (shop.plan === "free" && used >= FREE_JOB_LIMIT) {
        throw new PlanLimitError(
          `You have used all ${FREE_JOB_LIMIT} bulk edits included this month. Undo stays available on every plan.`,
        );
      }

      await tx.shop.update({
        where: { id: shopId },
        data: rolled
          ? { jobsThisMonth: 1, cycleStart: new Date() }
          : { jobsThisMonth: { increment: 1 } },
      });

      return tx.editJob.create({
        data: {
          shopId,
          name,
          status: "queued",
          idempotencyKey,
          filterJson: serializeScope(scope) as Prisma.InputJsonValue,
          actionsJson: actions as unknown as Prisma.InputJsonValue,
        },
      });
    },
    // Two Apply clicks landing together must not both pass the quota check.
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

/**
 * Queue the reverse of a finished job.
 *
 * An undo is a job like any other — it snapshots what it is about to overwrite,
 * shows up in history, and can itself be undone. It never consumes a job
 * credit: undo is free forever on every plan, which is the promise the whole
 * product is built on (SPEC §7).
 */
export async function createUndoJob(
  shopId: string,
  jobId: string,
): Promise<EditJob> {
  const original = await db.editJob.findFirst({ where: { id: jobId, shopId } });
  if (!original) throw new JobRequestError("That job no longer exists.");
  if (original.status === "queued" || original.status === "snapshotting" || original.status === "running") {
    throw new JobRequestError("This job is still running — wait for it to finish before undoing it.");
  }

  const applied = await db.snapshot.count({
    where: { jobId, applied: true },
  });
  if (applied === 0) {
    throw new JobRequestError("This job changed nothing, so there is nothing to undo.");
  }

  // Clicking Undo twice should open the undo already in flight, not start a
  // second one that would restore values the first one has already replaced.
  const existing = await db.editJob.findFirst({
    where: { shopId, undoOfJobId: jobId, status: { not: "failed" } },
    orderBy: { createdAt: "desc" },
  });
  if (existing) return existing;

  return db.editJob.create({
    data: {
      shopId,
      name: undoJobName(original.name),
      status: "queued",
      undoOfJobId: jobId,
      // Carried for display only. An undo resolves its rows from the original
      // job's snapshots, never by re-running this filter.
      filterJson: original.filterJson ?? Prisma.JsonNull,
      actionsJson: original.actionsJson ?? Prisma.JsonNull,
    },
  });
}

/**
 * Put a job's failed rows back in the queue.
 *
 * Rows that already applied are left alone, so this is a retry of the failures
 * only — never a second application of what worked (SPEC §5).
 */
export async function retryFailedRows(
  shopId: string,
  jobId: string,
): Promise<EditJob> {
  const job = await db.editJob.findFirst({ where: { id: jobId, shopId } });
  if (!job) throw new JobRequestError("That job no longer exists.");
  if (job.status !== "completed" && job.status !== "failed") {
    throw new JobRequestError("This job is still running.");
  }

  const cleared = await db.snapshot.updateMany({
    where: { jobId, applied: false, error: { not: null } },
    data: { error: null, bulkLine: null },
  });
  if (cleared.count === 0) {
    throw new JobRequestError("There are no failed rows to retry.");
  }

  return db.editJob.update({
    where: { id: jobId },
    data: {
      status: "queued",
      error: null,
      completedAt: null,
      bulkOpGid: null,
      stage: null,
      heartbeatAt: new Date(),
    },
  });
}

// --- running ----------------------------------------------------------------

/**
 * Run a job, then whatever else the shop has queued behind it.
 *
 * Returns as soon as the slot is unavailable or a bulk stage is in flight —
 * this is not a worker loop, it is one pass that leaves the world in a state
 * some later pass (a webhook, a stale sweep) can pick up.
 */
export async function runJob(
  admin: AdminApiContext,
  jobId: string,
): Promise<void> {
  const claimed = await claimRunSlot(jobId);
  if (!claimed) return;

  await executeJob(admin, claimed);
  await drainQueue(admin, claimed.shopId);
}

/**
 * Fire-and-forget entry point for request handlers.
 *
 * The HTTP response must not wait on a bulk edit, so the work is detached and
 * gets its own admin context from the stored offline token rather than
 * borrowing the request's — which would tie a multi-minute job's lifetime to a
 * page load.
 */
export function runJobDetached(shop: string, jobId: string): void {
  void (async () => {
    try {
      await runJob(await adminFor(shop), jobId);
    } catch (error) {
      await failJob(jobId, errorMessage(error)).catch(() => {});
    }
  })();
}

async function drainQueue(
  admin: AdminApiContext,
  shopId: string,
): Promise<void> {
  for (let guard = 0; guard < MAX_DRAIN; guard += 1) {
    const next = await db.editJob.findFirst({
      where: { shopId, status: "queued" },
      orderBy: { createdAt: "asc" },
    });
    if (!next) return;

    const claimed = await claimRunSlot(next.id);
    // The slot is held by something still in flight — a bulk stage waiting on
    // its webhook. Whoever finishes that will drain from here.
    if (!claimed) return;

    await executeJob(admin, claimed);
  }
}

/**
 * Take the shop's single run slot, atomically.
 *
 * Serializable because the check and the claim have to be one decision: two
 * requests reading "nothing is running" at the same instant is precisely the
 * race that would let two jobs edit the same product at once.
 *
 * A job that already has committed snapshots (`totalItems > 0`) is resumed
 * straight into `running` — re-entering `snapshotting` would rebuild a
 * before-picture that has already been partly applied, and destroy the undo.
 */
async function claimRunSlot(jobId: string): Promise<EditJob | null> {
  try {
    return await db.$transaction(
      async (tx) => {
        const job = await tx.editJob.findUnique({ where: { id: jobId } });
        if (!job || job.status !== "queued") return null;

        const active = await tx.editJob.count({
          where: {
            shopId: job.shopId,
            status: { in: ["snapshotting", "running"] },
          },
        });
        if (active > 0) return null;

        const status = job.totalItems > 0 ? "running" : "snapshotting";
        return tx.editJob.update({
          where: { id: jobId },
          data: {
            status,
            startedAt: job.startedAt ?? new Date(),
            heartbeatAt: new Date(),
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch {
    // A serialization conflict means somebody else claimed it first, which is
    // the correct outcome — just not ours.
    return null;
  }
}

async function executeJob(
  admin: AdminApiContext,
  job: EditJob,
): Promise<void> {
  try {
    let current = job;
    if (current.status === "snapshotting") {
      current = await snapshotPhase(admin, current);
    }
    if (current.status !== "running") return;
    await mutatePhase(admin, current);
  } catch (error) {
    await failJob(job.id, errorMessage(error));
  }
}

// --- phase 1: the before-picture --------------------------------------------

/**
 * Resolve what the job will change and commit the whole before-picture.
 *
 * The transaction at the end is the invariant. Snapshots and the flip to
 * `running` land together or not at all, so "status is running" is a durable
 * promise that every row is on disk.
 */
async function snapshotPhase(
  admin: AdminApiContext,
  job: EditJob,
): Promise<EditJob> {
  if (job.totalItems > 0) {
    throw new Error("Refusing to re-snapshot a job that already has one.");
  }
  // Only reachable with no committed snapshot set, so this clears the debris of
  // a run that died mid-write — never a before-picture anything was applied to.
  await db.snapshot.deleteMany({ where: { jobId: job.id } });

  const drafts = job.undoOfJobId
    ? await undoDraftsFor(admin, job.undoOfJobId)
    : await applyDraftsFor(admin, job);

  if (!drafts.length) {
    throw new IncompleteScopeError(
      "Nothing left to change — the catalog no longer matches this edit.",
    );
  }

  const mode = drafts.length <= SYNC_ITEM_LIMIT ? "sync" : "bulk";
  const writes: Prisma.PrismaPromise<unknown>[] = [];
  for (let i = 0; i < drafts.length; i += INSERT_CHUNK) {
    writes.push(
      db.snapshot.createMany({
        data: drafts.slice(i, i + INSERT_CHUNK).map((draft) => ({
          jobId: job.id,
          ownerGid: draft.ownerGid,
          productGid: draft.productGid,
          fieldPath: draft.fieldPath,
          oldValue: draft.oldValue,
          newValue: draft.newValue,
          drifted: draft.drifted,
          error: draft.error,
        })),
      }),
    );
  }
  writes.push(
    db.editJob.update({
      where: { id: job.id },
      data: {
        status: "running",
        mode,
        totalItems: drafts.length,
        heartbeatAt: new Date(),
      },
    }),
  );

  const results = await db.$transaction(writes);
  return results[results.length - 1] as EditJob;
}

async function applyDraftsFor(
  admin: AdminApiContext,
  job: EditJob,
): Promise<SnapshotDraft[]> {
  const scope = parseScope(job.filterJson);
  const actions = parseActions(JSON.stringify(job.actionsJson));
  // Resolving a large catalog can run for minutes, and until this returns the
  // job has not written a heartbeat since it claimed the slot. Past STALE_MS
  // that reads as a crash, and the sweep would requeue a job that is working
  // perfectly well — so the scan beats as it pages.
  const { drafts } = await buildApplyDrafts(admin, scope, actions, {
    onProgress: heartbeat(job.id),
  });
  return drafts;
}

async function undoDraftsFor(
  admin: AdminApiContext,
  originalJobId: string,
): Promise<SnapshotDraft[]> {
  const applied = await db.snapshot.findMany({
    where: { jobId: originalJobId, applied: true },
    select: {
      ownerGid: true,
      productGid: true,
      fieldPath: true,
      oldValue: true,
      newValue: true,
    },
    orderBy: { id: "asc" },
  });
  return buildUndoDrafts(admin, applied);
}

// --- phase 2: writing -------------------------------------------------------

/**
 * The gate. Nothing below this line may send a mutation for a job that has not
 * proven its before-picture is complete and durable.
 */
async function assertSnapshotsComplete(job: EditJob): Promise<void> {
  if (job.status !== "running") {
    throw new Error(`Refusing to mutate a job in status "${job.status}".`);
  }
  const persisted = await db.snapshot.count({ where: { jobId: job.id } });
  if (job.totalItems <= 0 || persisted !== job.totalItems) {
    throw new Error(
      `Refusing to mutate: ${persisted} of ${job.totalItems} snapshots are on disk.`,
    );
  }
}

async function mutatePhase(
  admin: AdminApiContext,
  job: EditJob,
): Promise<void> {
  await assertSnapshotsComplete(job);
  if (job.mode === "bulk") {
    await advanceBulk(admin, job);
    return;
  }
  await runInline(admin, job);
  await finishJob(job.id);
}

/** Rows still owed a write, for one stage. */
async function pendingFor(jobId: string, stage: MutationStage) {
  return db.snapshot.findMany({
    where: {
      jobId,
      applied: false,
      error: null,
      fieldPath: { startsWith: `${stage}.` },
    },
    select: {
      id: true,
      ownerGid: true,
      productGid: true,
      fieldPath: true,
      newValue: true,
    },
    orderBy: { id: "asc" },
  });
}

/**
 * The inline path: batched mutations, one stage at a time.
 *
 * A unit that fails marks its own rows and the job carries on. Failing the
 * whole job on one rejected product would strand the rest of a 90-row edit for
 * no reason — and the rows keep their message, so the job page can offer a
 * retry of exactly those.
 */
async function runInline(admin: AdminApiContext, job: EditJob): Promise<void> {
  const client = new ThrottledAdmin(admin);
  const beat = heartbeat(job.id);

  for (const stage of MUTATION_STAGES) {
    const pending = await pendingFor(job.id, stage);
    if (!pending.length) continue;

    const orphans = unaddressableIds(pending, stage);
    if (orphans.length) {
      await failRows(orphans, "No parent product recorded for this variant.");
    }

    const units = buildUnits(pending, stage, {
      maxVariantsPerUnit: VARIANTS_PER_MUTATION,
    });
    for (const unit of units) {
      await runUnit(client, stage, unit);
      await beat();
    }
  }
}

async function runUnit(
  client: ThrottledAdmin,
  stage: MutationStage,
  unit: MutationUnit,
): Promise<void> {
  try {
    const data = await client.run(STAGE_MUTATION[stage], unit.variables);
    const rejected = readUserError(data, stage);
    if (rejected) await failRows(unit.snapshotIds, rejected);
    else await applyRows(unit.snapshotIds);
  } catch (error) {
    await failRows(unit.snapshotIds, errorMessage(error));
  }
}

// --- phase 2b: the bulk path ------------------------------------------------

/**
 * Start the next bulk stage that still has work, or finish the job.
 *
 * Returning while a stage is in flight is the normal case: the job stays
 * `running`, holds the shop's slot, and is resumed by the webhook.
 */
async function advanceBulk(
  admin: AdminApiContext,
  job: EditJob,
): Promise<void> {
  for (const stage of MUTATION_STAGES) {
    const pending = await pendingFor(job.id, stage);
    if (!pending.length) continue;

    const orphans = unaddressableIds(pending, stage);
    if (orphans.length) {
      await failRows(orphans, "No parent product recorded for this variant.");
    }

    // One JSONL line per product — the shape Shopify's bulk mutations want.
    const units = buildUnits(pending, stage);
    if (!units.length) continue;

    await assignBulkLines(units);
    const gid = await startBulkStage(admin, stage, units);
    await db.editJob.update({
      where: { id: job.id },
      data: { bulkOpGid: gid, stage, heartbeatAt: new Date() },
    });
    return;
  }

  await finishJob(job.id);
}

/**
 * Record which JSONL line each row went out on.
 *
 * One statement rather than one per unit: a 2,000-product stage would otherwise
 * spend longer writing line numbers than Shopify spends applying the edit.
 */
async function assignBulkLines(units: MutationUnit[]): Promise<void> {
  const tuples: Prisma.Sql[] = [];
  units.forEach((unit, line) => {
    for (const id of unit.snapshotIds) {
      tuples.push(Prisma.sql`(${id}, ${line})`);
    }
  });
  if (!tuples.length) return;

  for (let i = 0; i < tuples.length; i += INSERT_CHUNK) {
    const chunk = tuples.slice(i, i + INSERT_CHUNK);
    await db.$executeRaw`
      UPDATE "Snapshot"
      SET "bulkLine" = v.line::int
      FROM (VALUES ${Prisma.join(chunk)}) AS v(id, line)
      WHERE "Snapshot"."id" = v.id::text
    `;
  }
}

/**
 * Settle a finished (or given-up) bulk stage and move the job along.
 *
 * Called from the `bulk_operations/finish` webhook and from the stale sweep, so
 * it has to be safe to run twice and safe to run on an operation that is still
 * going.
 */
export async function reconcileBulkJob(
  admin: AdminApiContext,
  job: EditJob,
): Promise<void> {
  if (!job.bulkOpGid || !job.stage) return;
  const stage = job.stage as MutationStage;

  const operation = await fetchBulkOperation(admin, job.bulkOpGid);
  if (!operation) {
    // The operation is gone and we cannot know what it did. Re-reading the
    // rows is not possible either, so the remaining work goes through the
    // inline path, which reports per row.
    await fallBackToInline(admin, job, "Shopify lost track of the bulk operation.");
    return;
  }

  if (operation.status === "CREATED" || operation.status === "RUNNING") {
    await db.editJob.update({
      where: { id: job.id },
      data: { heartbeatAt: new Date() },
    });
    return;
  }

  // A failed operation still reports what it managed before stopping, and those
  // rows are genuinely applied — reading `partialDataUrl` is what stops the
  // fallback from applying them a second time.
  const resultsUrl = operation.url ?? operation.partialDataUrl;
  if (resultsUrl) {
    await settleBulkResults(job.id, stage, resultsUrl);
  }

  if (operation.status === "COMPLETED") {
    // A completed operation answers every line it was given, so anything still
    // pending for this stage is a line Shopify never reported on. Starting the
    // stage again would submit the same rows and get the same silence, so the
    // remainder goes inline — where every row ends up either applied or with a
    // message explaining why not.
    const stranded = await pendingFor(job.id, stage);
    if (stranded.length) {
      await fallBackToInline(
        admin,
        job,
        `Shopify's bulk results left ${stranded.length} change(s) unaccounted for; they were applied directly instead.`,
      );
      return;
    }

    const fresh = await db.editJob.findUnique({ where: { id: job.id } });
    if (!fresh) return;
    await advanceBulk(admin, fresh);
    await drainQueue(admin, job.shopId);
    return;
  }

  await fallBackToInline(
    admin,
    job,
    `Bulk operation ${operation.status.toLowerCase()}${
      operation.errorCode ? ` (${operation.errorCode})` : ""
    }.`,
  );
}

async function settleBulkResults(
  jobId: string,
  stage: MutationStage,
  url: string,
): Promise<void> {
  const results = await fetchBulkResults(url);

  const rows = await db.snapshot.findMany({
    where: {
      jobId,
      applied: false,
      error: null,
      bulkLine: { not: null },
      fieldPath: { startsWith: `${stage}.` },
    },
    select: { id: true, bulkLine: true },
  });

  const byLine = new Map<number, string[]>();
  for (const row of rows) {
    const line = row.bulkLine as number;
    const bucket = byLine.get(line);
    if (bucket) bucket.push(row.id);
    else byLine.set(line, [row.id]);
  }

  const applied: string[] = [];
  for (const [line, ids] of byLine) {
    const payload = results.get(line);
    // No result for this line means Shopify never got to it. Leaving the rows
    // pending is what makes the fallback pick them up instead of guessing.
    if (payload === undefined) continue;

    const rejected = readUserError(payload, stage);
    if (rejected) await failRows(ids, rejected);
    else applied.push(...ids);
  }
  if (applied.length) await applyRows(applied);
}

/**
 * SPEC §5: if a bulk operation fails wholesale, finish the job with chunked
 * inline mutations rather than making the merchant start over.
 */
async function fallBackToInline(
  admin: AdminApiContext,
  job: EditJob,
  reason: string,
): Promise<void> {
  const fresh = await db.editJob.findUnique({ where: { id: job.id } });
  if (!fresh) return;

  await db.editJob.update({
    where: { id: job.id },
    data: { mode: "sync", stage: null, error: reason, heartbeatAt: new Date() },
  });

  await assertSnapshotsComplete(fresh);
  await runInline(admin, fresh);
  await finishJob(job.id);
  await drainQueue(admin, job.shopId);
}

/** Entry point for the `bulk_operations/finish` webhook. */
export async function handleBulkFinish(
  admin: AdminApiContext,
  shop: string,
  bulkOpGid: string,
): Promise<void> {
  const job = await db.editJob.findFirst({
    where: { shopId: shop, bulkOpGid, status: "running" },
  });
  // Not ours, or already settled — either way there is nothing to do. Other
  // bulk operations on this shop are none of our business.
  if (!job) return;
  await reconcileBulkJob(admin, job);
}

// --- resume -----------------------------------------------------------------

/**
 * Pick up jobs whose worker died.
 *
 * Called from the pages that show job state, which is enough: the only person
 * who needs a stalled job resumed is the one looking at it. A bulk job is
 * reconciled by polling its operation — that also covers a webhook that never
 * arrived, which is why the bulk path works in local development without a
 * public callback URL.
 *
 * There is no scheduled sweep behind this (SPEC §5). Jobs make progress when a
 * loader or a webhook fires, and nothing else moves them.
 */
export async function resumeStalledJobs(shopId: string): Promise<void> {
  await resumeActiveJobs(shopId);
  await resumeOrphanedQueue(shopId);
}

/** Jobs that were mutating, or about to, and stopped saying so. */
async function resumeActiveJobs(shopId: string): Promise<void> {
  const stale = new Date(Date.now() - STALE_MS);
  const jobs = await db.editJob.findMany({
    where: {
      shopId,
      status: { in: ["snapshotting", "running"] },
      OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: stale } }],
    },
  });

  for (const job of jobs) {
    // Claim the resume by stamping the heartbeat, so a second page load a
    // moment later doesn't start the same work again.
    const claimed = await db.editJob.updateMany({
      where: { id: job.id, heartbeatAt: job.heartbeatAt },
      data: { heartbeatAt: new Date() },
    });
    if (claimed.count === 0) continue;

    if (job.mode === "bulk" && job.bulkOpGid && job.stage) {
      reconcileDetached(shopId, job.id);
      continue;
    }

    await db.editJob.updateMany({
      where: { id: job.id, status: { in: ["snapshotting", "running"] } },
      data: { status: "queued" },
    });
    runJobDetached(shopId, job.id);
  }
}

/**
 * Pick up a job that is queued and has nobody coming for it.
 *
 * `resumeActiveJobs` only looks at `snapshotting` and `running`, which misses
 * the case where the process died between `createApplyJob` committing and
 * `claimRunSlot` taking the slot — or where `drainQueue` returned early because
 * a bulk stage held the slot, and the reconcile that should have drained it
 * never happened. Such a job is not stalled, it is invisible: no heartbeat ever
 * started, so no staleness check based on one can see it.
 *
 * The shop's slot is not bypassed. This only re-enters the job through
 * `runJobDetached`, which still has to win `claimRunSlot` like anything else —
 * and the `active` check first means a job legitimately waiting behind a
 * long-running edit is left alone however long it waits.
 */
async function resumeOrphanedQueue(shopId: string): Promise<void> {
  const active = await db.editJob.count({
    where: { shopId, status: { in: ["snapshotting", "running"] } },
  });
  if (active > 0) return;

  const stale = new Date(Date.now() - STALE_MS);
  const orphan = await db.editJob.findFirst({
    where: { shopId, status: "queued", updatedAt: { lt: stale } },
    orderBy: { createdAt: "asc" },
  });
  if (!orphan) return;

  // Claim by bumping the row, so the job page polling every two seconds does
  // not fire a fresh attempt on every tick while the first one is still
  // resolving its selection. `updatedAt` moves with this write, which is what
  // takes the job back out of the query above.
  const claimed = await db.editJob.updateMany({
    where: { id: orphan.id, status: "queued", updatedAt: orphan.updatedAt },
    data: { heartbeatAt: new Date() },
  });
  if (claimed.count === 0) return;

  // One is enough: `runJob` drains the rest of the shop's queue behind it.
  runJobDetached(shopId, orphan.id);
}

function reconcileDetached(shop: string, jobId: string): void {
  void (async () => {
    try {
      const job = await db.editJob.findUnique({ where: { id: jobId } });
      if (job) await reconcileBulkJob(await adminFor(shop), job);
    } catch (error) {
      await failJob(jobId, errorMessage(error)).catch(() => {});
    }
  })();
}

// --- row and job bookkeeping ------------------------------------------------

async function applyRows(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await db.snapshot.updateMany({
    where: { id: { in: ids } },
    data: { applied: true, appliedAt: new Date(), error: null },
  });
}

async function failRows(ids: string[], message: string): Promise<void> {
  if (!ids.length) return;
  await db.snapshot.updateMany({
    where: { id: { in: ids } },
    data: { error: message.slice(0, 500) },
  });
}

/** A rate-limited heartbeat writer, one per job run. */
function heartbeat(jobId: string): () => Promise<void> {
  let last = Date.now();
  return async () => {
    if (Date.now() - last < HEARTBEAT_MS) return;
    last = Date.now();
    await db.editJob
      .update({ where: { id: jobId }, data: { heartbeatAt: new Date() } })
      .catch(() => {});
  };
}

async function finishJob(jobId: string): Promise<void> {
  const [total, failed, job] = await Promise.all([
    db.snapshot.count({ where: { jobId } }),
    db.snapshot.count({ where: { jobId, error: { not: null } } }),
    db.editJob.findUnique({ where: { id: jobId } }),
  ]);
  if (!job) return;

  const status = total > 0 && failed === total ? "failed" : "completed";
  await db.editJob.update({
    where: { id: jobId },
    data: {
      status,
      failedItems: failed,
      completedAt: new Date(),
      stage: null,
      heartbeatAt: new Date(),
    },
  });

  // Mark what this job reversed, so history reads as a pair rather than as two
  // unrelated edits. Only on a clean undo — a partial one leaves the original
  // "completed with errors", which is the truth.
  if (job.undoOfJobId && status === "completed" && failed === 0) {
    await db.editJob.updateMany({
      where: { id: job.undoOfJobId, shopId: job.shopId },
      data: { status: "undone" },
    });
  }
}

async function failJob(jobId: string, message: string): Promise<void> {
  const failed = await db.snapshot.count({
    where: { jobId, error: { not: null } },
  });
  await db.editJob.updateMany({
    where: { id: jobId },
    data: {
      status: "failed",
      error: message.slice(0, 500),
      failedItems: failed,
      completedAt: new Date(),
      stage: null,
      heartbeatAt: new Date(),
    },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
