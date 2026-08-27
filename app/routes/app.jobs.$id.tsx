/**
 * Job detail: what a job is doing, what it did, what failed, and the Undo
 * button (SPEC §6).
 *
 * The page is a plain loader that re-runs itself while the job is active, which
 * is deliberately duller than streaming: a job's state lives in Postgres, and
 * the most reliable progress bar is one that reads it.
 */

import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import {
  useFetcher,
  useLoaderData,
  useRevalidator,
  useSearchParams,
} from "@remix-run/react";
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
  cancelScheduledJob,
  createUndoJob,
  resumeStalledJobs,
  retryFailedRows,
  runJobDetached,
} from "../lib/apply.server";
import {
  isActive,
  isPending,
  jobStatusLabel,
  jobStatusTone,
} from "../lib/jobs";
import { parseActions } from "../lib/actions";
import { formatValue } from "../lib/mutations";
import { fetchOwnerLabels, parseScope } from "../lib/snapshots.server";
import { TemplateError, saveTemplate } from "../lib/templates.server";
import { SaveTemplateModal } from "../components/save-template-modal";
import { JobRowsTable } from "../components/job-rows";
import type { JobRowView } from "../components/job-rows";

/** Result rows per page. Enough to scan, short enough to render instantly. */
const ROWS_PER_PAGE = 50;

/**
 * Characters of a stored value shown in a result cell.
 *
 * A description is a whole document; a table cell is not. The snapshot keeps
 * every byte — this only clips what is rendered, and matches the same limit the
 * preview diff table uses so the two read alike.
 */
const CELL_LIMIT = 160;

function clip(value: string): string {
  return value.length > CELL_LIMIT ? `${value.slice(0, CELL_LIMIT)}…` : value;
}

/** How often an in-flight job re-reads its own state. */
const POLL_MS = 2000;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shopId = session.shop;
  const jobId = params.id as string;

  // Someone watching a job is exactly who needs a crashed worker picked back
  // up, so the sweep lives here rather than in a cron process.
  await resumeStalledJobs(shopId);

  const job = await db.editJob.findFirst({ where: { id: jobId, shopId } });
  if (!job) throw new Response("Not found", { status: 404 });

  const url = new URL(request.url);
  const page = Math.max(0, Number.parseInt(url.searchParams.get("page") ?? "0", 10) || 0);
  const onlyFailed = url.searchParams.get("rows") === "failed";

  const rowFilter = onlyFailed
    ? { jobId, error: { not: null } }
    : { jobId };

  const [applied, failed, drifted, total, rows, undoJob, original] =
    await Promise.all([
      db.snapshot.count({ where: { jobId, applied: true } }),
      db.snapshot.count({ where: { jobId, error: { not: null } } }),
      db.snapshot.count({ where: { jobId, drifted: true } }),
      db.snapshot.count({ where: { jobId } }),
      db.snapshot.findMany({
        where: rowFilter,
        orderBy: [{ ownerGid: "asc" }, { fieldPath: "asc" }],
        skip: page * ROWS_PER_PAGE,
        take: ROWS_PER_PAGE,
      }),
      db.editJob.findFirst({
        where: { shopId, undoOfJobId: jobId },
        orderBy: { createdAt: "desc" },
        select: { id: true, name: true, status: true },
      }),
      job.undoOfJobId
        ? db.editJob.findFirst({
            where: { id: job.undoOfJobId, shopId },
            select: { id: true, name: true },
          })
        : Promise.resolve(null),
    ]);

  const filteredTotal = onlyFailed ? failed : total;
  const labels = await fetchOwnerLabels(
    admin,
    rows.map((row) => row.ownerGid),
  ).catch(() => new Map());

  const rowViews: JobRowView[] = rows.map((row) => {
    const label = labels.get(row.ownerGid);
    return {
      id: row.id,
      title: label?.title ?? row.ownerGid,
      detail: label?.detail ?? null,
      fieldPath: row.fieldPath,
      before: clip(formatValue(row.oldValue, row.fieldPath)),
      after: clip(formatValue(row.newValue, row.fieldPath)),
      applied: row.applied,
      drifted: row.drifted,
      error: row.error,
    };
  });

  return {
    job: {
      id: job.id,
      name: job.name,
      status: job.status,
      mode: job.mode,
      stage: job.stage,
      error: job.error,
      totalItems: job.totalItems,
      isUndo: Boolean(job.undoOfJobId),
      createdAt: job.createdAt.toISOString(),
      completedAt: job.completedAt?.toISOString() ?? null,
      scheduledFor: job.scheduledFor?.toISOString() ?? null,
      revertAt: job.revertAt?.toISOString() ?? null,
    },
    counts: { applied, failed, drifted, total },
    rows: rowViews,
    page,
    onlyFailed,
    hasNextPage: (page + 1) * ROWS_PER_PAGE < filteredTotal,
    undoJob,
    original,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;
  const jobId = params.id as string;
  const form = await request.formData();
  const intent = form.get("intent");

  try {
    if (intent === "undo") {
      const undo = await createUndoJob(shopId, jobId);
      runJobDetached(shopId, undo.id);
      return redirect(`/app/jobs/${undo.id}`);
    }
    if (intent === "cancelSchedule") {
      await cancelScheduledJob(shopId, jobId);
      return { ok: true, error: null };
    }
    if (intent === "retry") {
      const job = await retryFailedRows(shopId, jobId);
      runJobDetached(shopId, job.id);
      return { ok: true, error: null };
    }
    // SPEC §6: a job that worked is the most likely thing a merchant wants to
    // keep, so it can be saved as a template from here without rebuilding it.
    if (intent === "saveTemplate") {
      const job = await db.editJob.findFirst({ where: { id: jobId, shopId } });
      if (!job) throw new JobRequestError("That job no longer exists.");
      const scope = parseScope(job.filterJson);
      await saveTemplate({
        shopId,
        name: String(form.get("name") ?? job.name),
        filters: scope.filters,
        actions: parseActions(JSON.stringify(job.actionsJson)),
      });
      return { ok: true, error: null, saved: true };
    }
  } catch (error) {
    if (error instanceof JobRequestError || error instanceof TemplateError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }

  return { ok: false, error: "Unknown action." };
};

export default function JobDetail() {
  const { job, counts, rows, page, onlyFailed, hasNextPage, undoJob, original } =
    useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const fetcher = useFetcher<{
    ok: boolean;
    error: string | null;
    saved?: boolean;
  }>();
  const revalidator = useRevalidator();
  const [namingTemplate, setNamingTemplate] = useState(false);
  const savedTemplate = fetcher.data?.saved === true;

  useEffect(() => {
    if (savedTemplate) setNamingTemplate(false);
  }, [savedTemplate]);

  const active = isActive(job.status);

  // A running job's state lives in the database, so the page just keeps asking.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [active, revalidator]);

  const settled = counts.applied + counts.failed;
  const progress = useMemo(() => {
    if (job.status === "snapshotting") return 0;
    if (!counts.total) return active ? 0 : 100;
    return Math.round((settled / counts.total) * 100);
  }, [job.status, counts.total, settled, active]);

  const busy = fetcher.state !== "idle";
  const canUndo =
    (job.status === "completed" || job.status === "failed") &&
    counts.applied > 0;

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value === null) next.delete(key);
    else next.set(key, value);
    if (key === "rows") next.delete("page");
    setSearchParams(next, { preventScrollReset: true });
  };

  return (
    <Page
      backAction={{ content: "Amend", url: "/app" }}
      title={job.name}
      titleMetadata={
        <Badge tone={jobStatusTone(job.status, counts.failed)}>
          {jobStatusLabel(job.status, counts.failed)}
        </Badge>
      }
      subtitle={subtitle(job, counts)}
      primaryAction={
        isPending(job.status)
          ? {
              content: "Cancel this schedule",
              destructive: true,
              onAction: () =>
                fetcher.submit(
                  { intent: "cancelSchedule" },
                  { method: "POST" },
                ),
              loading: busy,
            }
          : canUndo
          ? {
              content: undoJob ? "View undo" : "Undo this edit",
              url: undoJob ? `/app/jobs/${undoJob.id}` : undefined,
              onAction: undoJob
                ? undefined
                : () => fetcher.submit({ intent: "undo" }, { method: "POST" }),
              loading: busy,
            }
          : undefined
      }
      secondaryActions={[
        ...(counts.failed > 0 && !active
          ? [
              {
                content: `Retry ${counts.failed} failed row${counts.failed === 1 ? "" : "s"}`,
                onAction: () =>
                  fetcher.submit({ intent: "retry" }, { method: "POST" }),
                loading: busy,
              },
            ]
          : []),
        // Not offered for an undo: its actions are carried for display only,
        // so a template made from one would not describe anything runnable.
        ...(job.isUndo
          ? []
          : [
              {
                content: "Save as template",
                onAction: () => setNamingTemplate(true),
              },
            ]),
      ]}
    >
      <TitleBar title="Job" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {fetcher.data?.error ? (
              <Banner tone="critical">
                <p>{fetcher.data.error}</p>
              </Banner>
            ) : null}

            {savedTemplate ? (
              <Banner
                tone="success"
                title="Saved as a template"
                action={{ content: "View templates", url: "/app/templates" }}
              >
                <p>This edit’s filter and actions are ready to run again.</p>
              </Banner>
            ) : null}

            <StatusBanner
              job={job}
              counts={counts}
              undoJob={undoJob}
              original={original}
            />

            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingSm">
                    {active ? phaseLabel(job) : "Result"}
                  </Text>
                  <Text as="span" variant="bodySm" tone="subdued">
                    {counts.total
                      ? `${settled.toLocaleString()} of ${counts.total.toLocaleString()} changes`
                      : "Working out what will change"}
                  </Text>
                </InlineStack>
                <ProgressBar
                  progress={progress}
                  tone={counts.failed > 0 ? "critical" : "primary"}
                  size="small"
                />
                <InlineStack gap="400" wrap>
                  <Stat label="Applied" value={counts.applied} />
                  <Stat label="Failed" value={counts.failed} />
                  {counts.drifted > 0 ? (
                    <Stat label="Changed since the edit" value={counts.drifted} />
                  ) : null}
                </InlineStack>
              </BlockStack>
            </Card>

            <Card padding="0">
              <Box padding="400" paddingBlockEnd="200">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingSm">
                    {onlyFailed ? "Failed rows" : "Every change"}
                  </Text>
                  {counts.failed > 0 ? (
                    <Button
                      variant="plain"
                      onClick={() =>
                        setParam("rows", onlyFailed ? null : "failed")
                      }
                    >
                      {onlyFailed
                        ? "Show all rows"
                        : `Show only the ${counts.failed} that failed`}
                    </Button>
                  ) : null}
                </InlineStack>
              </Box>

              <JobRowsTable rows={rows} isUndo={job.isUndo} />

              {rows.length ? (
                <Box padding="400">
                  <InlineStack align="center" gap="200">
                    <Button
                      disabled={page === 0}
                      onClick={() => setParam("page", String(page - 1))}
                    >
                      Previous
                    </Button>
                    <Button
                      disabled={!hasNextPage}
                      onClick={() => setParam("page", String(page + 1))}
                    >
                      Next
                    </Button>
                  </InlineStack>
                </Box>
              ) : (
                <EmptyState
                  heading={
                    active ? "No rows yet" : "This job recorded no changes"
                  }
                  image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                >
                  <p>
                    {active
                      ? "The before-values are still being recorded. Nothing has been written yet."
                      : "Nothing in the selection needed changing."}
                  </p>
                </EmptyState>
              )}
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>

      <SaveTemplateModal
        open={namingTemplate}
        defaultName={job.name}
        summary="this job’s filter and actions"
        saving={busy}
        error={fetcher.data?.error ?? null}
        onClose={() => setNamingTemplate(false)}
        onSave={(name) =>
          fetcher.submit({ intent: "saveTemplate", name }, { method: "POST" })
        }
      />
    </Page>
  );
}

function StatusBanner({
  job,
  counts,
  undoJob,
  original,
}: {
  job: {
    status: string;
    error: string | null;
    isUndo: boolean;
    scheduledFor: string | null;
    revertAt: string | null;
  };
  counts: { applied: number; failed: number; drifted: number };
  undoJob: { id: string; name: string; status: string } | null;
  original: { id: string; name: string } | null;
}) {
  if (job.status === "scheduled") {
    return (
      <Banner tone="info" title="Scheduled">
        <p>
          This edit runs on{" "}
          <strong>
            {job.scheduledFor
              ? new Date(job.scheduledFor).toLocaleString()
              : "its scheduled date"}
          </strong>
          . Nothing has been resolved yet — when it runs it finds whatever
          matches its filter at that moment, records the before-values, and only
          then writes.
          {job.revertAt
            ? ` It undoes itself on ${new Date(job.revertAt).toLocaleString()}.`
            : ""}
        </p>
      </Banner>
    );
  }

  if (job.status === "cancelled") {
    return (
      <Banner tone="info" title="Cancelled before it ran">
        <p>
          This edit was called off while it was still scheduled. Nothing was
          written, and no bulk edit was counted against your plan.
        </p>
      </Banner>
    );
  }

  if (job.status === "snapshotting") {
    return (
      <Banner tone="info" title="Recording the before-values">
        <p>
          Nothing has been written to your catalog yet. Every value this edit
          will overwrite is saved first — that is what makes the undo exact.
        </p>
      </Banner>
    );
  }

  if (job.status === "queued") {
    return (
      <Banner tone="info" title="Queued">
        <p>
          Another edit is running on this store. Amend runs one at a time so two
          edits can never disagree about the same product.
        </p>
      </Banner>
    );
  }

  if (job.status === "failed") {
    return (
      <Banner tone="critical" title="This edit failed">
        <p>{job.error ?? "Shopify rejected every change in this job."}</p>
        {counts.applied > 0 ? (
          <p>
            {counts.applied.toLocaleString()} change
            {counts.applied === 1 ? "" : "s"} did land, and undo will reverse
            exactly those.
          </p>
        ) : null}
      </Banner>
    );
  }

  if (job.status === "undone" && undoJob) {
    return (
      <Banner tone="info" title="This edit has been undone">
        <p>
          Restored by <Link url={`/app/jobs/${undoJob.id}`}>{undoJob.name}</Link>
          .
        </p>
      </Banner>
    );
  }

  if (job.status === "completed") {
    const tone = counts.failed > 0 ? "warning" : "success";
    return (
      <Banner
        tone={tone}
        title={
          counts.failed > 0
            ? `${counts.applied.toLocaleString()} applied, ${counts.failed.toLocaleString()} failed`
            : `${counts.applied.toLocaleString()} change${counts.applied === 1 ? "" : "s"} applied`
        }
      >
        <BlockStack gap="100">
          {job.isUndo && original ? (
            <p>
              Reversed <Link url={`/app/jobs/${original.id}`}>{original.name}</Link>.
            </p>
          ) : (
            <p>Undo restores every one of them exactly, on any plan.</p>
          )}
          {counts.drifted > 0 ? (
            <p>
              {counts.drifted.toLocaleString()} row
              {counts.drifted === 1 ? " had" : "s had"} been changed elsewhere
              since the original edit. They were restored anyway — the rows are
              flagged below.
            </p>
          ) : null}
          {job.error ? <p>{job.error}</p> : null}
        </BlockStack>
      </Banner>
    );
  }

  return null;
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <BlockStack gap="050">
      <Text as="span" variant="bodySm" tone="subdued">
        {label}
      </Text>
      <Text as="span" variant="headingMd">
        {value.toLocaleString()}
      </Text>
    </BlockStack>
  );
}

function phaseLabel(job: { status: string; mode: string }): string {
  if (job.status === "snapshotting") return "Saving undo data";
  if (job.status === "queued") return "Waiting for the store's turn";
  return job.mode === "bulk" ? "Applying in bulk" : "Applying";
}

function subtitle(
  job: { status: string; createdAt: string; completedAt: string | null },
  counts: { total: number },
): string {
  const started = new Date(job.createdAt).toLocaleString();
  if (!job.completedAt) return `Started ${started}`;
  const seconds = Math.max(
    1,
    Math.round(
      (new Date(job.completedAt).getTime() - new Date(job.createdAt).getTime()) /
        1000,
    ),
  );
  return `${counts.total.toLocaleString()} change${counts.total === 1 ? "" : "s"} · finished in ${formatDuration(seconds)}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}
