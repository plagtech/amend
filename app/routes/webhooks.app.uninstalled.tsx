import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been
  // uninstalled. If this webhook already ran, the session may have been deleted.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  // Mark the shop inactive and stamp the uninstall time. Actual data deletion
  // (jobs, snapshots, templates) is scheduled/retained per the shop/redact flow;
  // we keep undo snapshots available until Shopify's mandatory redaction window.
  await db.shop.updateMany({
    where: { id: shop },
    data: { active: false, uninstalledAt: new Date() },
  });

  return new Response();
};
