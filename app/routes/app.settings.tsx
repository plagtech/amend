/**
 * Settings (SPEC §6): the plan, the meter, and the two buttons that change
 * which of them applies.
 *
 * This page is also where `Shop.plan` gets re-checked against Shopify. The
 * `app_subscriptions/update` webhook keeps it current in normal operation; this
 * covers the case where a delivery was missed, and it is where a merchant
 * looks when the app disagrees with what they think they are paying for.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  InlineStack,
  Layout,
  List,
  Page,
  ProgressBar,
  Text,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  PRO_CURRENCY,
  PRO_PLAN,
  PRO_PRICE,
  PRO_TRIAL_DAYS,
  syncPlan,
} from "../lib/billing.server";
import {
  CYCLE_DAYS,
  FREE_JOB_LIMIT,
  FREE_TEMPLATE_LIMIT,
} from "../lib/jobs";

/**
 * Test charges on a development store.
 *
 * Shopify refuses real charges on a dev store anyway, so this is not a
 * shortcut — it is the only way the flow can be exercised before launch. It
 * follows the store, not a build flag, so a production store is always billed
 * for real even if this ships with the wrong NODE_ENV.
 */
function useTestCharges(shopDomain: string): boolean {
  return (
    process.env.BILLING_TEST === "1" ||
    shopDomain.endsWith(".myshopify.io") ||
    process.env.NODE_ENV !== "production"
  );
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing, session } = await authenticate.admin(request);
  const shopId = session.shop;
  const isTest = useTestCharges(shopId);

  const check = await billing.check({ isTest }).catch(() => null);
  const state = await syncPlan(shopId, check?.appSubscriptions ?? []);

  const [shop, templates] = await Promise.all([
    db.shop.findUnique({ where: { id: shopId } }),
    db.savedTemplate.count({ where: { shopId } }),
  ]);

  const cycleStart = shop?.cycleStart ?? new Date();
  const cycleEnd = new Date(cycleStart);
  cycleEnd.setDate(cycleEnd.getDate() + CYCLE_DAYS);
  const rolled = cycleEnd <= new Date();

  return {
    shopId,
    isTest,
    state,
    jobsThisMonth: rolled ? 0 : (shop?.jobsThisMonth ?? 0),
    renewsAt: (rolled ? new Date() : cycleEnd).toISOString(),
    templates,
    price: `${PRO_PRICE} ${PRO_CURRENCY}`,
    trialDays: PRO_TRIAL_DAYS,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { billing, session } = await authenticate.admin(request);
  const shopId = session.shop;
  const isTest = useTestCharges(shopId);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "subscribe") {
    // Throws a redirect to Shopify's confirmation page. The merchant approves
    // there, and Shopify returns them to `returnUrl` — where the loader above
    // syncs `Shop.plan` from what Shopify now reports.
    await billing.request({
      plan: PRO_PLAN,
      isTest,
      returnUrl: `${process.env.SHOPIFY_APP_URL}/app/settings?upgraded=1`,
    });
  }

  if (intent === "cancel") {
    const subscriptionId = String(form.get("subscriptionId") ?? "");
    if (!subscriptionId) {
      return { error: "That subscription is no longer active." };
    }
    await billing.cancel({ subscriptionId, isTest, prorate: true });
    // Don't wait for the webhook to tell us what we just did.
    await syncPlan(shopId, []);
    return { error: null };
  }

  return { error: null };
};

export default function Settings() {
  const {
    state,
    isTest,
    jobsThisMonth,
    renewsAt,
    templates,
    price,
    trialDays,
  } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ error: string | null }>();

  const pro = state.plan === "pro";
  const busy = fetcher.state !== "idle";
  const usagePct = Math.min(100, (jobsThisMonth / FREE_JOB_LIMIT) * 100);

  return (
    <Page
      backAction={{ content: "Amend", url: "/app" }}
      title="Settings"
      subtitle="Plan, usage and how long undo data is kept"
    >
      <TitleBar title="Settings" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {fetcher.data?.error ? (
              <Banner tone="critical">
                <p>{fetcher.data.error}</p>
              </Banner>
            ) : null}

            {isTest && pro ? (
              <Banner tone="info">
                <p>
                  This subscription is a <strong>test charge</strong>. Nothing
                  has been billed — development stores cannot be charged.
                </p>
              </Banner>
            ) : null}

            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      {pro ? "Amend Pro" : "Free"}
                    </Text>
                    <Badge tone={pro ? "success" : undefined}>
                      {pro ? (state.status ?? "Active") : "Current plan"}
                    </Badge>
                  </InlineStack>
                  {pro ? (
                    <Button
                      tone="critical"
                      variant="tertiary"
                      loading={busy}
                      onClick={() =>
                        fetcher.submit(
                          {
                            intent: "cancel",
                            subscriptionId: state.subscriptionId ?? "",
                          },
                          { method: "POST" },
                        )
                      }
                    >
                      Cancel subscription
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      loading={busy}
                      onClick={() =>
                        fetcher.submit({ intent: "subscribe" }, { method: "POST" })
                      }
                    >
                      Upgrade — {price}/month
                    </Button>
                  )}
                </InlineStack>

                {pro ? (
                  <Text as="p" variant="bodySm" tone="subdued">
                    Unlimited bulk edits, unlimited templates, regex find &
                    replace, scheduling, and 365-day undo history.
                    {state.currentPeriodEnd
                      ? ` Renews ${new Date(state.currentPeriodEnd).toLocaleDateString()}.`
                      : ""}
                  </Text>
                ) : (
                  <BlockStack gap="200">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Pro is {price} a month with a {trialDays}-day free trial:
                    </Text>
                    <List>
                      <List.Item>Unlimited bulk edits (free plan: {FREE_JOB_LIMIT} a month)</List.Item>
                      <List.Item>Unlimited saved templates (free plan: {FREE_TEMPLATE_LIMIT})</List.Item>
                      <List.Item>Regex find &amp; replace</List.Item>
                      <List.Item>Scheduled edits and automatic revert</List.Item>
                    </List>
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingSm">
                  This month
                </Text>
                {pro ? (
                  <Text as="p" variant="bodyMd">
                    {jobsThisMonth.toLocaleString()} bulk{" "}
                    {jobsThisMonth === 1 ? "edit" : "edits"} run. No limit on
                    your plan.
                  </Text>
                ) : (
                  <>
                    <ProgressBar
                      progress={usagePct}
                      tone={usagePct >= 100 ? "critical" : "primary"}
                      size="small"
                    />
                    <Text as="p" variant="bodySm" tone="subdued">
                      {jobsThisMonth} of {FREE_JOB_LIMIT} bulk edits used ·
                      resets {new Date(renewsAt).toLocaleDateString()}
                    </Text>
                  </>
                )}
                <Text as="p" variant="bodySm" tone="subdued">
                  {templates.toLocaleString()} saved{" "}
                  {templates === 1 ? "template" : "templates"}
                  {pro ? "" : ` of ${FREE_TEMPLATE_LIMIT}`}.
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingSm">
                  Undo data
                </Text>
                <Text as="p" variant="bodyMd">
                  Every edit stores its before-values, and undo is free on every
                  plan — including after a downgrade. Snapshots are kept for{" "}
                  <strong>{pro ? "365 days" : "90 days"}</strong>.
                </Text>
                <Box paddingBlockStart="200">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Cancelling returns you to the free allowance: {FREE_JOB_LIMIT}{" "}
                    edits a month and {FREE_TEMPLATE_LIMIT} runnable templates.
                    Nothing is deleted — extra templates stay in the list,
                    read-only, and any edit already running finishes.
                  </Text>
                </Box>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
