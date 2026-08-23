-- AlterTable
ALTER TABLE "EditJob" ADD COLUMN     "error" TEXT,
ADD COLUMN     "heartbeatAt" TIMESTAMP(3),
ADD COLUMN     "mode" TEXT NOT NULL DEFAULT 'sync',
ADD COLUMN     "stage" TEXT,
ADD COLUMN     "startedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Snapshot" ADD COLUMN     "appliedAt" TIMESTAMP(3),
ADD COLUMN     "bulkLine" INTEGER,
ADD COLUMN     "drifted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "productGid" TEXT;

-- CreateIndex
CREATE INDEX "EditJob_shopId_status_idx" ON "EditJob"("shopId", "status");

-- CreateIndex
CREATE INDEX "Snapshot_jobId_applied_idx" ON "Snapshot"("jobId", "applied");
