import type { ActionFunctionArgs } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import { downgradeToFree, isPaidStatus, syncPlan } from "../lib/billing.server";

/**
 * Shopify telling us a subscription changed state.
 *
 * This is what makes `Shop.plan` trustworthy as a gate. Without it the column
 * would only be as fresh as the last time someone opened the settings page —
 * and the states that matter most are the ones nobody visits the app to cause:
 * a card declining, a trial ending, a merchant cancelling from the Shopify
 * admin rather than from here.
 *
 * A downgrade lowers the allowance and nothing else: templates past the free
 * cap stay in the list read-only, snapshots stay, undo stays free, and a job
 * already running finishes (SPEC §7). The quota is only ever consulted when a
 * job is created or when a scheduled one fires.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  const subscription = (payload as { app_subscription?: Record<string, unknown> })
    ?.app_subscription;
  const status = String(subscription?.status ?? "");

  console.log(`Received ${topic} webhook for ${shop}: ${status || "unknown"}`);

  if (isPaidStatus(status)) {
    await syncPlan(shop, [
      {
        id: String(subscription?.admin_graphql_api_id ?? ""),
        name: String(subscription?.name ?? ""),
        status,
        test: Boolean(subscription?.test),
      },
    ]);
  } else {
    await downgradeToFree(shop);
  }

  return new Response();
};
