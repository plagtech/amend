import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// Mandatory GDPR compliance webhook: shop/redact.
// Fired 48h after a shop uninstalls. Delete all data we hold for the shop:
// sessions, jobs, snapshots, saved templates, and the shop record itself.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Delete children before parents to respect FK constraints.
  const jobs = await db.editJob.findMany({
    where: { shopId: shop },
    select: { id: true },
  });
  const jobIds = jobs.map((j) => j.id);

  await db.$transaction([
    db.snapshot.deleteMany({ where: { jobId: { in: jobIds } } }),
    db.editJob.deleteMany({ where: { shopId: shop } }),
    db.savedTemplate.deleteMany({ where: { shopId: shop } }),
    db.session.deleteMany({ where: { shop } }),
    db.shop.deleteMany({ where: { id: shop } }),
  ]);

  return new Response(null, { status: 200 });
};
