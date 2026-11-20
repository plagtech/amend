import type { ActionFunctionArgs } from "@remix-run/node";
import { Prisma } from "@prisma/client";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// Mandatory GDPR compliance webhook: shop/redact.
// Fired 48h after a shop uninstalls. Delete all data we hold for the shop:
// sessions, jobs, snapshots, saved templates, and the shop record itself.
//
// Unless the shop has come back: afterAuth (app/shopify.server.ts) sets
// `active: true, uninstalledAt: null` on reinstall, so a redact that arrives
// after that refers to an uninstall the merchant has since undone. Deleting
// then would wipe a live install's history and undo snapshots.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // The guard check, the job-id read and the deletes are one Serializable
  // transaction: a reinstall or a new job landing between the read and the
  // deletes would otherwise either be deleted against the guard's decision or
  // leave snapshots behind whose job delete then fails on the FK.
  const result = await db.$transaction(
    async (tx) => {
      const row = await tx.shop.findUnique({
        where: { id: shop },
        select: { active: true, uninstalledAt: true },
      });
      if (row && row.active && row.uninstalledAt === null) {
        return { skipped: true as const };
      }

      // Delete children before parents to respect FK constraints.
      const jobs = await tx.editJob.findMany({
        where: { shopId: shop },
        select: { id: true },
      });
      const jobIds = jobs.map((j) => j.id);

      const snapshots = await tx.snapshot.deleteMany({
        where: { jobId: { in: jobIds } },
      });
      const editJobs = await tx.editJob.deleteMany({ where: { shopId: shop } });
      const templates = await tx.savedTemplate.deleteMany({
        where: { shopId: shop },
      });
      const sessions = await tx.session.deleteMany({ where: { shop } });
      const shops = await tx.shop.deleteMany({ where: { id: shop } });

      return {
        skipped: false as const,
        counts: {
          snapshots: snapshots.count,
          jobs: editJobs.count,
          templates: templates.count,
          sessions: sessions.count,
          shop: shops.count,
        },
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      // Prisma's interactive default is 5s; a shop with a large snapshot
      // history can exceed that, and a timeout would fail every retry.
      timeout: 30_000,
      maxWait: 5_000,
    },
  );

  if (result.skipped) {
    console.log(
      `[shop/redact] SKIPPED deletion for ${shop}: shop is active with uninstalledAt=null (reinstalled after the uninstall that triggered this redact)`,
    );
  } else {
    const c = result.counts;
    console.log(
      `[shop/redact] DELETED data for ${shop}: snapshots=${c.snapshots} jobs=${c.jobs} templates=${c.templates} sessions=${c.sessions} shop=${c.shop}`,
    );
  }

  return new Response(null, { status: 200 });
};
