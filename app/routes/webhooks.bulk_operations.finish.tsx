import type { ActionFunctionArgs } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import { handleBulkFinish } from "../lib/apply.server";

/**
 * Shopify telling us a bulk operation has stopped — the completion signal for
 * every job that took the Bulk Operations path (SPEC §5), which is why nothing
 * here polls.
 *
 * The payload only identifies the operation; whether it belongs to one of our
 * jobs, and what to do about it, is `handleBulkFinish`'s call. Settling can
 * mean downloading a results file and falling back to inline mutations, which
 * is far more than the few seconds Shopify allows a webhook, so the response
 * goes out immediately and the work continues behind it. A delivery we drop on
 * the floor is not fatal either: the stale sweep polls the operation.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // No admin context means the app has been uninstalled since the operation
  // started. There is nothing left to reconcile against.
  if (!admin) return new Response();

  const gid = (payload as { admin_graphql_api_id?: unknown })
    ?.admin_graphql_api_id;
  if (typeof gid === "string") {
    void handleBulkFinish(admin, shop, gid).catch((error) => {
      console.error(`bulk_operations/finish for ${shop} failed:`, error);
    });
  }

  return new Response();
};
