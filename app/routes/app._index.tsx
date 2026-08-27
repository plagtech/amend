/**
 * Dashboard: recent jobs with their status and an undo button, the usage
 * meter, and the one CTA that starts a new edit (SPEC §6).
 *
 * The undo button lives here rather than only on the job page because that is
 * the promise the product is sold on — a merchant who has just noticed a bad
 * edit should not have to navigate to fix it.
 */

import { useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useFetcher, useLoaderData, useRevalidator } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  EmptyState,
  IndexTable,
  InlineStack,
  Layout,
  Link,
  Page,
  ProgressBar,
  Text,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  JobRequestError,
  createUndoJob,
  resumeStalledJobs,
  runJobDetached,
} from "../lib/apply.server";
import {
  CYCLE_DAYS,
  FREE_JOB_LIMIT,
  isActive,
  jobStatusLabel,
  jobStatusTone,
} from "../lib/jobs";

/** Jobs on the dashboard. Older ones live on their own pages. */
const RECENT_JOBS = 15;

const POLL_MS = 3000;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  await resumeStalledJobs(shopId);

  const [shop, jobs] = await Promise.all([
    db.shop.findUnique({ where: { id: shopId } }),
    db.editJob.findMany({
      where: { shopId, status: { not: "draft" } },
      orderBy: { createdAt: "desc" },
      take: RECENT_JOBS,
    }),
  ]);

  // One grouped query rather than one per job: an active job's progress is the
  // rows already written, which `EditJob` does not carry.
  const appliedCounts = jobs.length
    ? await db.snapshot.groupBy({
        by: ["jobId"],
        where: { jobId: { in: jobs.map((job) => job.id) }, applied: true },
        _count: { _all: true },
      })
    : [];
  const applied = new Map(
    appliedCounts.map((row) => [row.jobId, row._count._all]),
  );

  // Which jobs already have an undo, so the list offers "view" rather than a
  // second undo of the same edit.
  const undos = jobs.length
    ? await db.editJob.findMany({
        where: {
          shopId,
          undoOfJobId: { in: jobs.map((job) => job.id) },
          status: { not: "failed" },
        },
        select: { id: true, undoOfJobId: true },
      })
    : [];
  const undoOf = new Map(
    undos.map((undo) => [undo.undoOfJobId as string, undo.id]),
  );

  const cycleStart = shop?.cycleStart ?? new Date();
  const cycleEnd = new Date(cycleStart);
  cycleEnd.setDate(cycleEnd.getDate() + CYCLE_DAYS);
  const rolled = cycleEnd <= new Date();

  return {
    plan: shop?.plan ?? "free",
    jobsThisMonth: rolled ? 0 : (shop?.jobsThisMonth ?? 0),
    renewsAt: (rolled ? new Date() : cycleEnd).toISOString(),
    jobs: jobs.map((job) => ({
      id: job.id,
      name: job.name,
      status: job.status,
      isUndo: Boolean(job.undoOfJobId),
      totalItems: job.totalItems,
      failedItems: job.failedItems,
      appliedItems: applied.get(job.id) ?? 0,
      undoJobId: undoOf.get(job.id) ?? null,
      createdAt: job.createdAt.toISOString(),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const jobId = String(form.get("jobId") ?? "");

  try {
    const undo = await createUndoJob(session.shop, jobId);
    runJobDetached(session.shop, undo.id);
    return redirect(`/app/jobs/${undo.id}`);
  } catch (error) {
    if (error instanceof JobRequestError) {
      return { error: error.message };
    }
    throw error;
  }
};

export default function Index() {
  const { plan, jobsThisMonth, renewsAt, jobs } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ error: string }>();
  const revalidator = useRevalidator();

  const anyActive = jobs.some((job) => isActive(job.status));
  useEffect(() => {
    if (!anyActive) return;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [anyActive, revalidator]);

  const usagePct = Math.min(100, (jobsThisMonth / FREE_JOB_LIMIT) * 100);
  const atLimit = plan === "free" && jobsThisMonth >= FREE_JOB_LIMIT;
  const busy = fetcher.state !== "idle";

  return (
    <Page
      title="Amend"
      primaryAction={{
        content: "New bulk edit",
        url: "/app/edit/new",
        disabled: atLimit,
      }}
      secondaryActions={[{ content: "Templates", url: "/app/templates" }]}
    >
      <TitleBar title="Amend" />
      <BlockStack gap="500">
        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              {fetcher.data?.error ? (
                <Banner tone="critical">
                  <p>{fetcher.data.error}</p>
                </Banner>
              ) : null}

              {atLimit ? (
                <Banner
                  tone="warning"
                  title={`You have used all ${FREE_JOB_LIMIT} bulk edits this month`}
                  action={{ content: "Upgrade to Pro", url: "/app/settings" }}
                >
                  <p>
                    Your allowance renews on{" "}
                    {new Date(renewsAt).toLocaleDateString()}. Undo keeps
                    working in the meantime — it never counts against your
                    limit, on any plan.
                  </p>
                </Banner>
              ) : null}

              {jobs.length === 0 ? (
                <Card>
                  <EmptyState
                    heading="The bulk editor that never breaks your catalog"
                    action={{ content: "New bulk edit", url: "/app/edit/new" }}
                    image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                  >
                    <p>
                      Filter products, preview every before → after change,
                      apply in one job, and undo with a single click. No job
                      history yet — start your first bulk edit.
                    </p>
                  </EmptyState>
                </Card>
              ) : (
                <Card padding="0">
                  <Box padding="400" paddingBlockEnd="200">
                    <Text as="h2" variant="headingSm">
                      Recent edits
                    </Text>
                  </Box>
                  <IndexTable
                    resourceName={{ singular: "job", plural: "jobs" }}
                    itemCount={jobs.length}
                    selectable={false}
                    headings={[
                      { title: "Edit" },
                      { title: "When" },
                      { title: "Changes", alignment: "end" },
                      { title: "Status" },
                      { title: "" },
                    ]}
                  >
                    {jobs.map((job, index) => (
                      <IndexTable.Row id={job.id} key={job.id} position={index}>
                        <IndexTable.Cell>
                          <InlineStack gap="200" blockAlign="center" wrap={false}>
                            <Link url={`/app/jobs/${job.id}`} removeUnderline>
                              <Text as="span" variant="bodyMd" fontWeight="semibold">
                                {job.name}
                              </Text>
                            </Link>
                            {job.isUndo ? <Badge>Undo</Badge> : null}
                          </InlineStack>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {new Date(job.createdAt).toLocaleString()}
                          </Text>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <ChangeCount job={job} />
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <Badge
                            tone={jobStatusTone(job.status, job.failedItems)}
                          >
                            {jobStatusLabel(job.status, job.failedItems)}
                          </Badge>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <UndoCell job={job} busy={busy} fetcher={fetcher} />
                        </IndexTable.Cell>
                      </IndexTable.Row>
                    ))}
                  </IndexTable>
                </Card>
              )}
            </BlockStack>
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
                      <Button url="/app/settings">See Pro</Button>
                    </BlockStack>
                  ) : (
                    <BlockStack gap="200">
                      <Text as="p" variant="bodyMd">
                        Unlimited jobs, scheduling, and 365-day undo retention.
                      </Text>
                      <Button url="/app/settings" variant="tertiary">
                        Manage plan
                      </Button>
                    </BlockStack>
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

interface JobView {
  id: string;
  status: string;
  totalItems: number;
  failedItems: number;
  appliedItems: number;
  undoJobId: string | null;
}

function ChangeCount({ job }: { job: JobView }) {
  if (isActive(job.status) && job.totalItems > 0) {
    return (
      <Text as="span" variant="bodyMd" tone="subdued">
        {job.appliedItems.toLocaleString()} / {job.totalItems.toLocaleString()}
      </Text>
    );
  }
  return (
    <Text as="span" variant="bodyMd">
      {job.appliedItems.toLocaleString()}
    </Text>
  );
}

function UndoCell({
  job,
  busy,
  fetcher,
}: {
  job: JobView;
  busy: boolean;
  fetcher: ReturnType<typeof useFetcher<{ error: string }>>;
}) {
  if (job.undoJobId) {
    return (
      <Button variant="plain" url={`/app/jobs/${job.undoJobId}`}>
        View undo
      </Button>
    );
  }
  if (isActive(job.status) || job.appliedItems === 0) return null;

  return (
    <Button
      variant="plain"
      loading={busy}
      onClick={() => fetcher.submit({ jobId: job.id }, { method: "POST" })}
    >
      Undo
    </Button>
  );
}
