import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

// Mandatory GDPR compliance webhook: customers/data_request.
// Amend stores no customer personal data — it operates on products/variants only.
// There is nothing to compile or return, so we acknowledge with 200.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`, {
    shopDomain: (payload as { shop_domain?: string })?.shop_domain,
  });

  // No customer data held. Acknowledge.
  return new Response(null, { status: 200 });
};
