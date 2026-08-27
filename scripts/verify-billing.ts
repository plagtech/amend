/**
 * The billing lifecycle, against the dev store, with a test charge.
 *
 *   npm run verify:billing
 *
 * ## Why this one needs a person
 *
 * Two steps in a subscription cannot be automated, by design:
 *
 *   1. **An app can only bill as itself.** Shopify refuses `appSubscriptionCreate`
 *      from a custom app's Admin API token — "this application is currently
 *      owned by a Shop. It must be migrated to the Shopify partners area before
 *      it can create charges" — so the seed token every other script uses is
 *      useless here. This one runs as the app, with the offline token the app
 *      stored when it was installed. If there isn't one, it says so and stops.
 *   2. **A merchant has to approve the charge.** There is no API that accepts a
 *      subscription on the merchant's behalf, and there should not be. The
 *      script prints the confirmation URL and waits.
 *
 * Everything either side of that click is automated and asserted: creating the
 * subscription, the app seeing it go active, `Shop.plan` following it, the
 * gates opening, cancelling, and the gates closing again.
 *
 * Charges are created with `test: true`. Development stores cannot be charged
 * for real, so nothing here can cost anyone money.
 */

import process from "node:process";

import db from "../app/db.server";
import type { EditAction } from "../app/lib/actions";
import { emptyMatch } from "../app/lib/actions";
import {
  PRO_CURRENCY,
  PRO_PLAN,
  PRO_PRICE,
  PRO_TRIAL_DAYS,
  assertActionsAllowed,
  planFor,
  syncPlan,
} from "../app/lib/billing.server";
import { emptyFilters } from "../app/lib/filters";
import { FREE_TEMPLATE_LIMIT } from "../app/lib/jobs";
import { listTemplates, saveTemplate } from "../app/lib/templates.server";
import {
  API_VERSION,
  assertTrue,
  check,
  expectError,
  loadEnvFile,
  report,
  sleep,
} from "./harness";

/** How long to wait for the merchant to approve before giving up. */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_MS = 5_000;

const REGEX_EDIT: EditAction[] = [
  {
    type: "text",
    field: "title",
    op: "replace",
    match: { find: "^(\\w+)", replaceWith: "$1", caseSensitive: false, regex: true },
    value: "",
  },
];

const SUBSCRIPTION_QUERY = `#graphql
  query VerifyBillingState {
    currentAppInstallation {
      app { id title }
      activeSubscriptions { id name status test trialDays currentPeriodEnd }
    }
  }
`;

const CREATE_MUTATION = `#graphql
  mutation VerifyBillingCreate(
    $name: String!
    $lineItems: [AppSubscriptionLineItemInput!]!
    $returnUrl: URL!
    $test: Boolean
    $trialDays: Int
  ) {
    appSubscriptionCreate(
      name: $name
      lineItems: $lineItems
      returnUrl: $returnUrl
      test: $test
      trialDays: $trialDays
    ) {
      appSubscription { id name status test }
      confirmationUrl
      userErrors { field message }
    }
  }
`;

const CANCEL_MUTATION = `#graphql
  mutation VerifyBillingCancel($id: ID!) {
    appSubscriptionCancel(id: $id) {
      appSubscription { id status }
      userErrors { field message }
    }
  }
`;

interface Subscription {
  id: string;
  name: string;
  status: string;
  test: boolean;
  trialDays?: number;
  currentPeriodEnd?: string | null;
}

async function main(): Promise<void> {
  loadEnvFile();
  if (!process.env.DATABASE_URL) {
    console.error("Set DATABASE_URL in .env.");
    process.exit(1);
  }

  // The app's own credentials, as stored at install time. Not the seed token:
  // only the app can bill for the app.
  const session = await db.session.findFirst({ where: { isOnline: false } });
  if (!session?.accessToken) {
    console.error(
      [
        "No app session found — billing can only be exercised as the app itself.",
        "",
        "  1. npm run dev        (shopify app dev)",
        "  2. open the app in the dev store once, so the install stores a token",
        "  3. npm run verify:billing",
      ].join("\n"),
    );
    process.exit(1);
  }

  const shop = session.shop;
  const gql = async <T>(query: string, variables: Record<string, unknown> = {}) => {
    const response = await fetch(
      `https://${shop}/admin/api/${API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": session.accessToken,
        },
        body: JSON.stringify({ query, variables }),
      },
    );
    const body = (await response.json()) as {
      data?: T;
      errors?: unknown;
    };
    if (body.errors || !body.data) {
      const detail = JSON.stringify(body.errors ?? "no data");
      if (detail.includes("Invalid API key or access token")) {
        throw new Error(
          "The stored app token is no longer valid. Run `npm run dev` and open the app once to refresh it, then re-run.",
        );
      }
      throw new Error(`Shopify rejected the request: ${detail}`);
    }
    return body.data;
  };

  const readSubscriptions = async (): Promise<Subscription[]> => {
    const data = await gql<{
      currentAppInstallation: {
        app: { title: string };
        activeSubscriptions: Subscription[];
      };
    }>(SUBSCRIPTION_QUERY);
    return data.currentAppInstallation.activeSubscriptions;
  };

  try {
    console.log(`Shop: ${shop}\n`);

    // --- starting point ----------------------------------------------------
    console.log("Before — the app on the free plan:");
    const existing = await readSubscriptions();
    if (existing.length) {
      console.log(
        `      … cancelling a leftover subscription (${existing[0].status})`,
      );
      await gql(CANCEL_MUTATION, { id: existing[0].id });
      await sleep(2000);
    }
    await syncPlan(shop, []);
    check("the app reports the free plan", await planFor(shop), "free");
    await expectError(
      "and regex is refused on it",
      async () => assertActionsAllowed(await planFor(shop), REGEX_EDIT),
      (message) => message.includes("Regular-expression"),
    );

    // --- subscribe ---------------------------------------------------------
    console.log("\nSubscribe — a test charge, created by the app:");
    const created = await gql<{
      appSubscriptionCreate: {
        appSubscription: Subscription | null;
        confirmationUrl: string | null;
        userErrors: { message: string }[];
      };
    }>(CREATE_MUTATION, {
      name: PRO_PLAN,
      returnUrl: `${process.env.SHOPIFY_APP_URL || `https://${shop}/admin`}/app/settings?upgraded=1`,
      test: true,
      trialDays: PRO_TRIAL_DAYS,
      lineItems: [
        {
          plan: {
            appRecurringPricingDetails: {
              price: { amount: PRO_PRICE, currencyCode: PRO_CURRENCY },
              interval: "EVERY_30_DAYS",
            },
          },
        },
      ],
    });

    const payload = created.appSubscriptionCreate;
    check("Shopify raised no errors", payload.userErrors, []);
    assertTrue("a subscription was created", Boolean(payload.appSubscription));
    check("it is a test charge", payload.appSubscription?.test, true);
    check(
      "it is the plan the app declares",
      payload.appSubscription?.name,
      PRO_PLAN,
    );
    check("it is pending approval", payload.appSubscription?.status, "PENDING");
    check(
      "and a pending subscription does not upgrade the shop",
      (await syncPlan(shop, await readSubscriptions())).plan,
      "free",
    );

    console.log(
      [
        "",
        "  ACTION NEEDED — approve the test charge:",
        "",
        `  ${payload.confirmationUrl}`,
        "",
        `  Nothing is billed: development stores cannot be charged, and this is a test charge.`,
        `  Waiting up to ${APPROVAL_TIMEOUT_MS / 60000} minutes…`,
        "",
      ].join("\n"),
    );

    // --- confirm -----------------------------------------------------------
    const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
    let active: Subscription | undefined;
    for (;;) {
      const subscriptions = await readSubscriptions();
      active = subscriptions.find((entry) => entry.status === "ACTIVE");
      if (active) break;
      if (Date.now() > deadline) {
        throw new Error(
          "The charge was never approved. Re-run when you can click through it.",
        );
      }
      await sleep(POLL_MS);
    }

    console.log("Confirmed — the app sees the subscription:");
    check("Shopify reports it active", active.status, "ACTIVE");
    check("still a test charge", active.test, true);
    check("with the trial the plan declares", active.trialDays, PRO_TRIAL_DAYS);

    const state = await syncPlan(shop, await readSubscriptions());
    check("the app's own plan follows it", state.plan, "pro");
    check("Shop.plan is what the gates read", await planFor(shop), "pro");
    assertTrue(
      "the subscription id was recorded for cancellation",
      Boolean(state.subscriptionId),
    );

    // --- what the plan buys ------------------------------------------------
    console.log("\nGates — open on Pro:");
    assertTrue(
      "regex is allowed",
      (() => {
        try {
          assertActionsAllowed("pro", REGEX_EDIT);
          return true;
        } catch {
          return false;
        }
      })(),
    );

    const before = (await listTemplates(shop)).length;
    const overCap: string[] = [];
    for (let i = before; i <= FREE_TEMPLATE_LIMIT; i += 1) {
      const template = await saveTemplate({
        shopId: shop,
        name: `verify billing template ${i + 1}`,
        filters: emptyFilters(),
        actions: [
          { type: "tags", op: "add", tags: ["sale"], match: emptyMatch() },
        ],
      });
      overCap.push(template.id);
    }
    assertTrue(
      "templates save past the free cap",
      (await listTemplates(shop)).length > FREE_TEMPLATE_LIMIT,
    );
    check(
      "and none of them are locked",
      (await listTemplates(shop)).filter((template) => template.locked).length,
      0,
    );

    // --- cancel ------------------------------------------------------------
    console.log("\nCancel — back to the free allowance:");
    const cancelled = await gql<{
      appSubscriptionCancel: {
        appSubscription: { status: string } | null;
        userErrors: { message: string }[];
      };
    }>(CANCEL_MUTATION, { id: active.id });
    check("Shopify raised no errors", cancelled.appSubscriptionCancel.userErrors, []);
    check(
      "the subscription is cancelled",
      cancelled.appSubscriptionCancel.appSubscription?.status,
      "CANCELLED",
    );

    const afterCancel = await syncPlan(shop, await readSubscriptions());
    check("the app is back on free", afterCancel.plan, "free");
    check("and the gates read free", await planFor(shop), "free");
    await expectError(
      "regex is refused again",
      async () => assertActionsAllowed(await planFor(shop), REGEX_EDIT),
      (message) => message.includes("Regular-expression"),
    );

    const listed = await listTemplates(shop);
    check(
      "no template was deleted by the downgrade",
      listed.length > FREE_TEMPLATE_LIMIT,
      true,
    );
    check(
      "the ones past the cap are read-only",
      listed.filter((template) => template.locked).length,
      listed.length - FREE_TEMPLATE_LIMIT,
    );

    // Clean up only what this script created.
    if (overCap.length) {
      await db.savedTemplate.deleteMany({ where: { id: { in: overCap } } });
    }
  } finally {
    await db.$disconnect();
  }

  report();
}

main().catch(async (error) => {
  console.error(`\nVerification failed: ${(error as Error).message}`);
  await db.$disconnect().catch(() => {});
  // Set the code and let the loop drain rather than calling process.exit — an
  // in-flight fetch being torn down mid-request makes libuv complain loudly on
  // Windows, which reads like a second, unrelated failure.
  process.exitCode = 1;
});
