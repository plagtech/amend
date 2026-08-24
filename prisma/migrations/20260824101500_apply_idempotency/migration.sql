-- Phase 4 follow-up: make Apply idempotent, and give the stale sweep a way to
-- spot a job that was queued and then orphaned.

-- The key the browser receives with its preview and sends back with Apply.
-- Nullable because every job created before this migration has no key, and
-- because undo and retry jobs are not created from a preview.
ALTER TABLE "EditJob" ADD COLUMN "idempotencyKey" TEXT;

-- The unique index is the whole mechanism: a replayed confirm POST loses the
-- insert race and is resolved back to the job the first POST created.
CREATE UNIQUE INDEX "EditJob_idempotencyKey_key" ON "EditJob"("idempotencyKey");

-- Last write to the row. `heartbeatAt` only moves while a job is actively
-- running, so it cannot distinguish a freshly queued job from one whose worker
-- died before it ever claimed the run slot. Existing rows are backfilled to now
-- rather than to createdAt: it is the conservative direction, giving any job
-- already in the table a full staleness window before the sweep touches it.
ALTER TABLE "EditJob" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- The sweep's query: queued jobs for one shop, oldest first.
CREATE INDEX "EditJob_shopId_status_updatedAt_idx" ON "EditJob"("shopId", "status", "updatedAt");
