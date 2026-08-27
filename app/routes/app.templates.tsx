/**
 * Saved templates (SPEC §6): the filter + action stacks a merchant keeps, and
 * the one button that matters — "Use", which opens the wizard with all of it
 * already filled in.
 *
 * There is no editing here on purpose. A template is cheap to re-save from the
 * wizard, and an edit form for a filter that already has a much better editor
 * one click away would be a second, worse copy of it.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  EmptyState,
  InlineStack,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { FREE_TEMPLATE_LIMIT } from "../lib/jobs";
import { deleteTemplate, listTemplates } from "../lib/templates.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  const [templates, shop] = await Promise.all([
    listTemplates(shopId),
    db.shop.findUnique({ where: { id: shopId } }),
  ]);

  return { templates, plan: shop?.plan ?? "free" };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();

  if (form.get("intent") === "delete") {
    await deleteTemplate(session.shop, String(form.get("id") ?? ""));
    return { ok: true };
  }
  return { ok: false };
};

export default function Templates() {
  const { templates, plan } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const atLimit = plan === "free" && templates.length >= FREE_TEMPLATE_LIMIT;

  return (
    <Page
      backAction={{ content: "Amend", url: "/app" }}
      title="Templates"
      subtitle="Saved filters and edit actions, ready to run again"
      primaryAction={{ content: "New bulk edit", url: "/app/edit/new" }}
    >
      <TitleBar title="Templates" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {atLimit ? (
              <Banner tone="info" title="Template limit reached">
                <p>
                  The free plan keeps {FREE_TEMPLATE_LIMIT} saved templates.
                  Delete one to save another — every saved edit still runs, and
                  undo is free on any plan.
                </p>
              </Banner>
            ) : null}

            {templates.length === 0 ? (
              <Card>
                <EmptyState
                  heading="No saved templates yet"
                  action={{ content: "New bulk edit", url: "/app/edit/new" }}
                  image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                >
                  <p>
                    Build an edit in the wizard and choose “Save as template” to
                    keep its filter and actions for next time.
                  </p>
                </EmptyState>
              </Card>
            ) : (
              <Card padding="0">
                <BlockStack gap="0">
                  {templates.map((template, index) => (
                    <Box
                      key={template.id}
                      padding="400"
                      borderBlockStartWidth={index === 0 ? undefined : "025"}
                      borderColor="border"
                    >
                      <InlineStack
                        align="space-between"
                        blockAlign="center"
                        gap="400"
                        wrap
                      >
                        <BlockStack gap="100">
                          <Text as="h2" variant="headingSm">
                            {template.name}
                          </Text>
                          <Text as="p" variant="bodySm">
                            {template.summary}
                          </Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {template.scope}
                          </Text>
                        </BlockStack>
                        <InlineStack gap="200">
                          <Button variant="primary" url={template.href}>
                            Use
                          </Button>
                          <Button
                            tone="critical"
                            variant="tertiary"
                            loading={
                              fetcher.state !== "idle" &&
                              fetcher.formData?.get("id") === template.id
                            }
                            onClick={() =>
                              fetcher.submit(
                                { intent: "delete", id: template.id },
                                { method: "POST" },
                              )
                            }
                          >
                            Delete
                          </Button>
                        </InlineStack>
                      </InlineStack>
                    </Box>
                  ))}
                </BlockStack>
              </Card>
            )}

            <Text as="p" variant="bodySm" tone="subdued">
              A template stores the filter and the actions, never a list of
              products — running it again edits whatever matches at that moment.
            </Text>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
