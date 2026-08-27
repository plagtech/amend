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
import { redirect } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Badge,
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
import {
  TemplateError,
  deleteTemplate,
  listTemplates,
  openTemplate,
} from "../lib/templates.server";

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
  const intent = form.get("intent");
  const id = String(form.get("id") ?? "");

  if (intent === "delete") {
    await deleteTemplate(session.shop, id);
    return { ok: true, error: null };
  }

  // "Use" is a POST, not a link, so the plan check happens on the server. A
  // locked template is readable but not runnable, and typing the wizard URL by
  // hand does not change that — the wizard's own quota and regex gates still
  // apply to whatever is built there.
  if (intent === "use") {
    try {
      return redirect(await openTemplate(session.shop, id));
    } catch (error) {
      if (error instanceof TemplateError) {
        return { ok: false, error: error.message };
      }
      throw error;
    }
  }

  return { ok: false, error: null };
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
            {fetcher.data?.error ? (
              <Banner tone="warning" title="This template is read-only">
                <p>{fetcher.data.error}</p>
              </Banner>
            ) : null}

            {atLimit ? (
              <Banner
                tone="info"
                title="Template limit reached"
                action={{ content: "See plans", url: "/app/settings" }}
              >
                <p>
                  The free plan runs {FREE_TEMPLATE_LIMIT} saved templates.
                  Anything past that is kept and readable but marked read-only —
                  nothing is ever deleted. Undo stays free on any plan.
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
                          <InlineStack gap="200" blockAlign="center">
                            <Text as="h2" variant="headingSm">
                              {template.name}
                            </Text>
                            {template.locked ? (
                              <Badge tone="attention">Read-only</Badge>
                            ) : null}
                          </InlineStack>
                          <Text as="p" variant="bodySm">
                            {template.summary}
                          </Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {template.scope}
                          </Text>
                        </BlockStack>
                        <InlineStack gap="200">
                          <Button
                            variant="primary"
                            disabled={template.locked}
                            loading={
                              fetcher.state !== "idle" &&
                              fetcher.formData?.get("intent") === "use" &&
                              fetcher.formData?.get("id") === template.id
                            }
                            onClick={() =>
                              fetcher.submit(
                                { intent: "use", id: template.id },
                                { method: "POST" },
                              )
                            }
                          >
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
