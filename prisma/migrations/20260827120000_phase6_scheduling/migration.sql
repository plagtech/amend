-- Phase 6: scheduling, auto-revert and the bulk reconcile claim.
--
-- `scheduledFor` and `revertAt` already exist (0_init); what they lacked was
-- anything that could find them without a full scan, now that a timer asks
-- "anything due?" across every shop every tick.

-- Held while reconcileBulkJob is in flight. Nullable, expires on its own.
ALTER TABLE "EditJob" ADD COLUMN "reconcileLockAt" TIMESTAMP(3);

-- The scheduler's two questions.
CREATE INDEX "EditJob_status_scheduledFor_idx" ON "EditJob"("status", "scheduledFor");
CREATE INDEX "EditJob_revertAt_idx" ON "EditJob"("revertAt");
