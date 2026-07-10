import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

// Mandatory GDPR compliance webhook: customers/redact.
// Amend stores no customer personal data, so there is nothing to redact.
// Acknowledge with 200.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // No customer data held. Acknowledge.
  return new Response(null, { status: 200 });
};
