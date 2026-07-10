import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  ProgressBar,
  EmptyState,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const FREE_JOB_LIMIT = 10;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await db.shop.findUnique({ where: { id: session.shop } });

  return {
    plan: shop?.plan ?? "free",
    jobsThisMonth: shop?.jobsThisMonth ?? 0,
  };
};

export default function Index() {
  const { plan, jobsThisMonth } = useLoaderData<typeof loader>();
  const usagePct = Math.min(100, (jobsThisMonth / FREE_JOB_LIMIT) * 100);

  return (
    <Page>
      <TitleBar title="Amend" />
      <BlockStack gap="500">
        <Layout>
          <Layout.Section>
            <Card>
              <EmptyState
                heading="The bulk editor that never breaks your catalog"
                action={{ content: "New bulk edit", url: "/app/edit/new" }}
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>
                  Filter products, preview every before → after change, apply in
                  one job, and undo with a single click. No job history yet —
                  start your first bulk edit.
                </p>
              </EmptyState>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <BlockStack gap="500">
              <Card>
                <BlockStack gap="200">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Plan
                    </Text>
                    <Badge tone={plan === "pro" ? "success" : undefined}>
                      {plan === "pro" ? "Pro" : "Free"}
                    </Badge>
                  </InlineStack>
                  {plan === "free" ? (
                    <BlockStack gap="200">
                      <Text as="p" variant="bodyMd">
                        {jobsThisMonth} of {FREE_JOB_LIMIT} jobs used this month.
                      </Text>
                      <ProgressBar progress={usagePct} size="small" />
                      <Text as="p" variant="bodySm" tone="subdued">
                        Undo is always free and never counts against your limit.
                      </Text>
                    </BlockStack>
                  ) : (
                    <Text as="p" variant="bodyMd">
                      Unlimited jobs, scheduling, and 365-day undo retention.
                    </Text>
                  )}
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
