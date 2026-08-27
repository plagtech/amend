/**
 * The background trigger (SPEC §5, §9 Phase 6).
 *
 * Until now nothing moved a job unless somebody loaded a page or a webhook
 * landed. That was an accepted trade while every job started with a click; it
 * stops being acceptable the moment a job is scheduled for 6am on Friday, when
 * by definition nobody is looking.
 *
 * ## What this is, and why this and not something else
 *
 * An in-process interval in the web server. Chosen over the alternatives on
 * the grounds that matter for a single-instance Railway deploy:
 *
 *   - **BullMQ + Redis + a worker service** (what SPEC §2 originally sketched)
 *     is the "right" answer at scale and the wrong one here: it doubles the
 *     deploy (a second service, a Redis instance, a second copy of the engine's
 *     configuration) to run a handful of timers a day.
 *   - **An external cron hitting an HTTP endpoint** needs a public URL that is
 *     authenticated but not session-authenticated — a new auth surface, on the
 *     one endpoint that can start writes to a merchant's catalog.
 *   - **A `setInterval` in the process that already has the database, the
 *     engine, and the offline tokens** needs none of that. It is the smallest
 *     thing that makes a scheduled job fire on time.
 *
 * The cost is honest and worth writing down: it only works while at least one
 * web instance is up, and it assumes roughly one instance. Both hold for this
 * deploy and neither is silently assumed — see the claim discipline below,
 * which is what a second instance would need anyway.
 *
 * ## Overlap and double-entry
 *
 * Two guards, because they fail differently:
 *
 *   - In-process: ticks never overlap. The timer is re-armed *after* a tick
 *     finishes (`setTimeout` chaining, not `setInterval`), and a re-entrancy
 *     flag covers a manual `runSchedulerTick()` racing the timer.
 *   - Cross-process: every transition is a compare-and-set. Promoting a
 *     scheduled job is `UPDATE … WHERE status = 'scheduled'`, and firing an
 *     auto-revert is `UPDATE … WHERE revertAt IS NOT NULL`. Whoever's update
 *     reports one row won; everyone else does nothing. Two instances, or a tick
 *     racing a webhook, cannot both act on the same job.
 */

import db from "../db.server";
import type { AdminResolver } from "./apply.server";
import {
  cancelJobOverQuota,
  createUndoJob,
  resumeStalledJobs,
  runJobDetached,
  spendCreditForScheduledJob,
} from "./apply.server";
import { PlanLimitError } from "./billing.server";

export interface SchedulerOptions {
  /**
   * How to get an admin client for a shop. Defaults to the app's stored offline
   * token, which is what the server uses; `scripts/verify-schedule.ts` passes a
   * token-backed one so a scheduled job can be watched firing on its own
   * without an app installation in the loop.
   */
  adminFor?: AdminResolver;
}

/** How often the tick runs. Kept low enough that "6am" means 6am. */
const DEFAULT_TICK_MS = 30_000;

/** Jobs promoted per tick. A backstop, not a throttle — there is never a queue. */
const MAX_PER_TICK = 25;

export interface TickResult {
  promoted: number;
  reverted: number;
  swept: number;
  refused: number;
}

const EMPTY_TICK: TickResult = {
  promoted: 0,
  reverted: 0,
  swept: 0,
  refused: 0,
};

declare global {
  // eslint-disable-next-line no-var
  var amendSchedulerStarted: boolean | undefined;
}

let ticking = false;
let timer: NodeJS.Timeout | null = null;

export function schedulerTickMs(): number {
  const configured = Number.parseInt(process.env.SCHEDULER_TICK_MS ?? "", 10);
  return Number.isFinite(configured) && configured >= 1000
    ? configured
    : DEFAULT_TICK_MS;
}

/**
 * Start the timer. Safe to call more than once — the module is evaluated again
 * on every dev-server reload, and a second timer would double every tick.
 *
 * `SCHEDULER_DISABLED=1` turns it off: that is how the verification scripts
 * drive ticks by hand, and how a future multi-instance deploy would keep the
 * timer on one instance.
 */
export function startScheduler(options: SchedulerOptions = {}): void {
  if (process.env.SCHEDULER_DISABLED === "1") return;
  if (global.amendSchedulerStarted) return;
  global.amendSchedulerStarted = true;

  const interval = schedulerTickMs();
  console.log(`[scheduler] started, every ${interval}ms`);

  const arm = () => {
    // Re-armed after the tick resolves, so a slow tick delays the next one
    // instead of stacking on top of it.
    timer = setTimeout(() => {
      void runSchedulerTick(options)
        .catch((error) => console.error("[scheduler] tick failed:", error))
        .finally(arm);
    }, interval);
    // Never hold the process open for a timer; the web server's own listener
    // is what should decide when this process lives and dies.
    timer.unref?.();
  };
  arm();
}

export function stopScheduler(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  global.amendSchedulerStarted = false;
}

/**
 * One pass: fire what is due, revert what has expired, resume what stalled.
 *
 * Exported so the verification script can run a tick directly rather than
 * waiting on wall-clock time.
 */
export async function runSchedulerTick(
  options: SchedulerOptions = {},
): Promise<TickResult> {
  if (ticking) return EMPTY_TICK;
  ticking = true;
  try {
    const [fired, reverted, swept] = [
      await promoteDueJobs(options),
      await fireDueReverts(options),
      await sweepActiveShops(),
    ];
    return {
      promoted: fired.promoted,
      refused: fired.refused,
      reverted,
      swept,
    };
  } finally {
    ticking = false;
  }
}

/**
 * Scheduled jobs whose time has come.
 *
 * The quota is checked *here*, not when the job was scheduled: a merchant who
 * schedules four sales in January and is out of credits in February should be
 * told which one could not run, and told in the job history rather than by
 * nothing happening (SPEC §7). A refused job is marked failed with the plan
 * message on it — the same message the wizard would have shown.
 */
async function promoteDueJobs(options: SchedulerOptions): Promise<{
  promoted: number;
  refused: number;
}> {
  const due = await db.editJob.findMany({
    where: { status: "scheduled", scheduledFor: { lte: new Date() } },
    orderBy: { scheduledFor: "asc" },
    take: MAX_PER_TICK,
  });

  let promoted = 0;
  let refused = 0;

  for (const job of due) {
    // The claim. Whoever flips it out of `scheduled` owns it; a second ticker,
    // or a second instance, gets zero rows and moves on.
    const claimed = await db.editJob.updateMany({
      where: { id: job.id, status: "scheduled" },
      data: { status: "queued", heartbeatAt: new Date() },
    });
    if (claimed.count === 0) continue;

    try {
      await spendCreditForScheduledJob(job.shopId);
    } catch (error) {
      if (error instanceof PlanLimitError) {
        await cancelJobOverQuota(job.id, error.message);
        refused += 1;
        continue;
      }
      throw error;
    }

    // From here it is an ordinary queued job: it still has to win the shop's
    // run slot, and if another edit is running it waits behind it.
    runJobDetached(job.shopId, job.id, options.adminFor);
    promoted += 1;
  }

  return { promoted, refused };
}

/**
 * Sale windows: a completed job with a `revertAt` in the past gets undone.
 *
 * Clearing `revertAt` is the claim — it is also the honest record, since the
 * revert has now happened and should not happen twice. An undo consumes no
 * credit on any plan, so unlike a scheduled apply this can never be refused.
 */
async function fireDueReverts(options: SchedulerOptions): Promise<number> {
  const due = await db.editJob.findMany({
    where: {
      revertAt: { lte: new Date() },
      status: { in: ["completed", "failed"] },
    },
    orderBy: { revertAt: "asc" },
    take: MAX_PER_TICK,
  });

  let reverted = 0;
  for (const job of due) {
    const claimed = await db.editJob.updateMany({
      where: { id: job.id, revertAt: job.revertAt },
      data: { revertAt: null },
    });
    if (claimed.count === 0) continue;

    try {
      const undo = await createUndoJob(job.shopId, job.id);
      runJobDetached(job.shopId, undo.id, options.adminFor);
      reverted += 1;
    } catch (error) {
      // A job with nothing applied has nothing to revert. That is not a
      // failure of the schedule, and the claim above means it is not retried.
      console.error(`[scheduler] auto-revert of ${job.id} skipped:`, error);
    }
  }
  return reverted;
}

/**
 * The sweep SPEC §5 deferred: `resumeStalledJobs` for every shop with work in
 * flight, without waiting for someone to open a page.
 *
 * Shops are found from the jobs themselves rather than by walking every shop —
 * a shop with nothing running needs nothing swept.
 */
async function sweepActiveShops(): Promise<number> {
  const shops = await db.editJob.findMany({
    where: { status: { in: ["queued", "snapshotting", "running"] } },
    distinct: ["shopId"],
    select: { shopId: true },
    take: 100,
  });

  for (const { shopId } of shops) {
    await resumeStalledJobs(shopId).catch((error) =>
      console.error(`[scheduler] sweep of ${shopId} failed:`, error),
    );
  }
  return shops.length;
}
