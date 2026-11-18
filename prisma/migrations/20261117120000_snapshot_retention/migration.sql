-- Phase 7: snapshot retention (SPEC §7 — 90 days free, 365 Pro).
--
-- The sweep deletes a finished job's Snapshot rows once they are past the
-- shop's retention window. The job row itself stays, and records when its
-- before-values went, so the app can say "undo expired" instead of silently
-- losing the Undo button.

ALTER TABLE "EditJob" ADD COLUMN "snapshotsPrunedAt" TIMESTAMP(3);

-- The sweep's question: finished jobs whose snapshots are still present.
CREATE INDEX "EditJob_status_snapshotsPrunedAt_idx" ON "EditJob"("status", "snapshotsPrunedAt");
