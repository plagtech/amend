/**
 * Snapshot retention (SPEC §7): undo data is deleted after 90 days on Free and
 * 365 on Pro, and a job past its window says "undo expired" — it never turns
 * into a failed undo.
 *
 *   npm run verify:retention
 *
 * Drives the same entry points the app uses — `pruneExpiredSnapshots` (what
 * the scheduler tick calls), `createUndoJob`, `retryFailedRows` — against two
 * shops of its own, with jobs aged by back-dating `completedAt`. The prune is
 * scoped to those shops, so no real job in the database is ever touched.
 *
 * Touches Postgres only — no Shopify calls, seconds to run.
 */

import process from "node:process";

import db from "../app/db.server";
import {
  JobRequestError,
  createUndoJob,
  retryFailedRows,
} from "../app/lib/apply.server";
import { SNAPSHOT_RETENTION_DAYS } from "../app/lib/jobs";
import { pruneExpiredSnapshots } from "../app/lib/retention.server";
import { assertTrue, check, loadEnvFile, report, sleep } from "./harness";

const FREE_SHOP = "amend-verify-retention-free.myshopify.test";
const PRO_SHOP = "amend-verify-retention-pro.myshopify.test";
const SHOPS = [FREE_SHOP, PRO_SHOP];

const DAY_MS = 24 * 60 * 60 * 1000;
const ROWS = 4;

interface JobSpec {
  shopId: string;
  status: string;
  ageDays: number;
  revertAt?: Date;
  undoOfJobId?: string;
  failedRows?: number;
}

async function makeJob(spec: JobSpec): Promise<string> {
  const finished = new Date(Date.now() - spec.ageDays * DAY_MS);
  const failed = spec.failedRows ?? 0;
  const job = await db.editJob.create({
    data: {
      shopId: spec.shopId,
      name: `retention ${spec.status} ${spec.ageDays}d`,
      filterJson: {},
      actionsJson: [],
      status: spec.status,
      totalItems: ROWS,
      failedItems: failed,
      createdAt: finished,
      completedAt: ["completed", "failed", "undone"].includes(spec.status)
        ? finished
        : null,
      revertAt: spec.revertAt ?? null,
      undoOfJobId: spec.undoOfJobId ?? null,
    },
  });
  await db.snapshot.createMany({
    data: Array.from({ length: ROWS }, (_, i) => ({
      jobId: job.id,
      ownerGid: `gid://shopify/ProductVariant/${i + 1}`,
      productGid: "gid://shopify/Product/1",
      fieldPath: "variant.price",
      oldValue: JSON.stringify("10.00"),
      newValue: JSON.stringify("9.00"),
      applied: i >= failed,
      error: i < failed ? "rejected" : null,
    })),
  });
  return job.id;
}

async function prunedAt(jobId: string): Promise<Date | null> {
  return (
    (await db.editJob.findUnique({
      where: { id: jobId },
      select: { snapshotsPrunedAt: true },
    }))?.snapshotsPrunedAt ?? null
  );
}

const rowsOf = (jobId: string) => db.snapshot.count({ where: { jobId } });

async function setPlan(shopId: string, plan: "free" | "pro"): Promise<void> {
  await db.shop.upsert({
    where: { id: shopId },
    create: { id: shopId, plan },
    update: { plan },
  });
}

/** Run `fn` and return the JobRequestError message it threw, or null. */
async function refusal(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    if (error instanceof JobRequestError) return error.message;
    throw error;
  }
}

async function main(): Promise<void> {
  loadEnvFile();
  if (!process.env.DATABASE_URL) {
    console.error("Set DATABASE_URL in .env.");
    process.exit(1);
  }

  const { free, pro } = SNAPSHOT_RETENTION_DAYS;
  const prune = () => pruneExpiredSnapshots({ shopIds: SHOPS });

  try {
    await reset();
    await setPlan(FREE_SHOP, "free");
    await setPlan(PRO_SHOP, "pro");

    // --- the windows -------------------------------------------------------
    console.log(`Windows — ${free} days on Free, ${pro} on Pro:`);
    const freshFree = await makeJob({ shopId: FREE_SHOP, status: "completed", ageDays: free - 1 });
    const oldFree = await makeJob({ shopId: FREE_SHOP, status: "completed", ageDays: free + 1, failedRows: 1 });
    const oldFailed = await makeJob({ shopId: FREE_SHOP, status: "failed", ageDays: free + 5 });
    const oldUndone = await makeJob({ shopId: FREE_SHOP, status: "undone", ageDays: free + 5 });
    const midPro = await makeJob({ shopId: PRO_SHOP, status: "completed", ageDays: free + 30 });
    const oldPro = await makeJob({ shopId: PRO_SHOP, status: "completed", ageDays: pro + 1 });

    // --- never pruned, whatever their age ------------------------------------
    const running = await makeJob({ shopId: FREE_SHOP, status: "running", ageDays: free + 30 });
    const scheduled = await makeJob({ shopId: FREE_SHOP, status: "scheduled", ageDays: free + 30 });
    const pendingRevert = await makeJob({
      shopId: FREE_SHOP,
      status: "completed",
      ageDays: free + 30,
      revertAt: new Date(Date.now() + DAY_MS),
    });
    const undoTarget = await makeJob({ shopId: FREE_SHOP, status: "completed", ageDays: free + 30 });
    await makeJob({
      shopId: FREE_SHOP,
      status: "queued",
      ageDays: 0,
      undoOfJobId: undoTarget,
    });

    const first = await prune();
    check("one pass prunes exactly the expired finished jobs", first.jobs, 4);
    check("and deletes their rows", first.snapshots, 4 * ROWS);

    check("a Free job one day inside its window keeps its undo", await rowsOf(freshFree), ROWS);
    check("a Free job one day past it loses its rows", await rowsOf(oldFree), 0);
    assertTrue("and records when", (await prunedAt(oldFree)) !== null);
    check("a failed job past the window is pruned too", await rowsOf(oldFailed), 0);
    check("so is an undone one", await rowsOf(oldUndone), 0);
    check("a Pro job past 90 days but inside 365 keeps its undo", await rowsOf(midPro), ROWS);
    check("a Pro job past 365 days is pruned", await rowsOf(oldPro), 0);

    const kept = await db.editJob.findUnique({ where: { id: oldFree } });
    assertTrue("the job row itself is kept", Boolean(kept));
    check("with its totals intact", [kept?.totalItems, kept?.failedItems], [ROWS, 1]);

    console.log("\nNever pruned:");
    check("a running job", await rowsOf(running), ROWS);
    check("a scheduled job", await rowsOf(scheduled), ROWS);
    check("a job with an auto-revert still due", await rowsOf(pendingRevert), ROWS);
    check("a job whose undo is in flight", await rowsOf(undoTarget), ROWS);

    check("a second pass finds nothing left to do", (await prune()).jobs, 0);

    // --- expired, not failed -------------------------------------------------
    console.log("\nUndo after expiry — refused, never a failed undo:");
    const undoMessage = await refusal(() => createUndoJob(FREE_SHOP, oldFree));
    assertTrue(
      "createUndoJob refuses with the expired message",
      Boolean(undoMessage?.includes("expired")),
    );
    assertTrue(
      "and it is not the 'changed nothing' message",
      !undoMessage?.includes("changed nothing"),
    );
    check(
      "no undo job was created",
      await db.editJob.count({ where: { undoOfJobId: oldFree } }),
      0,
    );
    const retryMessage = await refusal(() => retryFailedRows(FREE_SHOP, oldFree));
    assertTrue(
      "retrying its failed rows is refused as expired too",
      Boolean(retryMessage?.includes("expired")),
    );
    const liveUndo = await createUndoJob(FREE_SHOP, freshFree);
    check("a job inside its window still undoes", liveUndo.undoOfJobId, freshFree);

    // --- plan changes --------------------------------------------------------
    console.log("\nPlan changes:");
    await setPlan(PRO_SHOP, "free");
    await prune();
    check(
      "a downgrade shortens the window for a Pro job already past 90 days",
      await rowsOf(midPro),
      0,
    );

    const upgraded = await makeJob({ shopId: FREE_SHOP, status: "completed", ageDays: free + 10 });
    await setPlan(FREE_SHOP, "pro");
    await prune();
    check("an upgrade keeps a Free job's undo that has not yet gone", await rowsOf(upgraded), ROWS);
    await setPlan(FREE_SHOP, "free");

    // --- the claim -----------------------------------------------------------
    console.log("\nThe claim — two sweeps, and undo racing a sweep:");
    await prune(); // settle everything above, so the count below is only the racers
    const racers = await Promise.all(
      Array.from({ length: 6 }, () =>
        makeJob({ shopId: FREE_SHOP, status: "completed", ageDays: free + 3 }),
      ),
    );
    const [a, b] = await Promise.all([prune(), prune()]);
    check("two concurrent sweeps prune each job once between them", a.jobs + b.jobs, racers.length);
    check(
      "and every one of them is pruned",
      await db.snapshot.count({ where: { jobId: { in: racers } } }),
      0,
    );

    // Alternate which side starts first and by how much, from a dead heat to a
    // clear lead. A bare Promise.all tends to land the same way every round,
    // which would leave one outcome — and the half of the lock protocol that
    // produces it — untested. Every round must be consistent, and each side
    // must win at least once.
    const HEAD_STARTS_MS = [0, 20, 100, 400];
    let consistent = 0;
    let undoWins = 0;
    let pruneWins = 0;
    const ROUNDS = 12;
    for (let round = 0; round < ROUNDS; round += 1) {
      const target = await makeJob({ shopId: FREE_SHOP, status: "completed", ageDays: free + 3 });
      const lead = round % 2 === 0 ? "undo" : "prune";
      const delay = HEAD_STARTS_MS[Math.floor(round / 2) % HEAD_STARTS_MS.length];
      const after = <T,>(go: () => Promise<T>) =>
        sleep(delay).then(go);
      const startUndo = () =>
        createUndoJob(FREE_SHOP, target).then(
          (job) => ({ created: job.id }),
          (error) => ({ refused: (error as Error).message }),
        );
      const [undoOutcome] = await Promise.all([
        lead === "undo" ? startUndo() : after(startUndo),
        lead === "prune" ? prune() : after(prune),
      ]);
      const gone = (await prunedAt(target)) !== null;
      const rows = await rowsOf(target);
      const undos = await db.editJob.count({ where: { undoOfJobId: target } });
      // Exactly one of the two may win, and the loser must see the winner.
      const undoWon = "created" in undoOutcome && !gone && rows === ROWS && undos === 1;
      const pruneWon =
        "refused" in undoOutcome &&
        undoOutcome.refused.includes("expired") &&
        gone &&
        rows === 0 &&
        undos === 0;
      if (undoWon || pruneWon) consistent += 1;
      if (undoWon) undoWins += 1;
      if (pruneWon) pruneWins += 1;
      // Let the next round's sweep see this target as settled.
      await db.editJob.updateMany({
        where: { undoOfJobId: target },
        data: { status: "completed" },
      });
    }
    check(
      `undo and sweep never both win, or both lose (${ROUNDS} races)`,
      consistent,
      ROUNDS,
    );
    assertTrue(`the undo won at least once (${undoWins} of ${ROUNDS})`, undoWins > 0);
    assertTrue(`the sweep won at least once (${pruneWins} of ${ROUNDS})`, pruneWins > 0);
  } finally {
    await reset();
    await db.$disconnect();
  }

  report();
}

/** These shops are entirely ours; leaving rows behind would corrupt a re-run. */
async function reset(): Promise<void> {
  const jobs = await db.editJob.findMany({
    where: { shopId: { in: SHOPS } },
    select: { id: true },
  });
  await db.snapshot.deleteMany({
    where: { jobId: { in: jobs.map((job) => job.id) } },
  });
  await db.editJob.deleteMany({ where: { shopId: { in: SHOPS } } });
  await db.shop.deleteMany({ where: { id: { in: SHOPS } } });
}

main().catch(async (error) => {
  console.error(`\nVerification failed: ${(error as Error).message}`);
  await reset().catch(() => {});
  await db.$disconnect().catch(() => {});
  process.exitCode = 1;
});
