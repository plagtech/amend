/**
 * Job vocabulary shared by the engine and the pages that render it.
 *
 * Isomorphic, like `filters.ts` and `actions.ts`: the dashboard and the job
 * page render statuses from here, and `apply.server.ts` transitions between the
 * same strings. Keeping them in one place is what stops a status the UI has no
 * label for from ever reaching the database.
 */

import type { EditAction } from "./actions";

/**
 * A job's lifecycle.
 *
 *   draft         created but not submitted (unused in v1 — the wizard submits
 *                 straight to `queued`; reserved for saved/scheduled jobs)
 *   queued        accepted, waiting for the shop's run slot
 *   snapshotting  resolving the selection and persisting before-values
 *   running       snapshots are complete and durable; mutations are in flight
 *   completed     every row was attempted (check `failedItems` for partials)
 *   failed        the job could not run, or every row failed
 *   undone        an undo job has since restored this job's before-values
 */
export const JOB_STATUSES = [
  "draft",
  "queued",
  "snapshotting",
  "running",
  "completed",
  "failed",
  "undone",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/** Statuses that occupy the shop's single run slot. */
export const ACTIVE_STATUSES: JobStatus[] = [
  "queued",
  "snapshotting",
  "running",
];

/** Statuses where the job page should keep refreshing itself. */
export function isActive(status: string): boolean {
  return (ACTIVE_STATUSES as string[]).includes(status);
}

export function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "undone";
}

export function jobStatusLabel(status: string, failedItems = 0): string {
  switch (status) {
    case "draft":
      return "Draft";
    case "queued":
      return "Queued";
    case "snapshotting":
      return "Preparing undo data";
    case "running":
      return "Applying";
    case "completed":
      return failedItems > 0 ? "Completed with errors" : "Completed";
    case "failed":
      return "Failed";
    case "undone":
      return "Undone";
    default:
      return status;
  }
}

/** Polaris `Badge` tones. `undefined` is Polaris's neutral default. */
export function jobStatusTone(
  status: string,
  failedItems = 0,
): "success" | "attention" | "critical" | "info" | undefined {
  switch (status) {
    case "completed":
      return failedItems > 0 ? "attention" : "success";
    case "failed":
      return "critical";
    case "running":
    case "snapshotting":
      return "info";
    case "queued":
      return "attention";
    default:
      return undefined;
  }
}

/** Free plan allowance. Undo never counts against it — see SPEC §7. */
export const FREE_JOB_LIMIT = 10;

/** Days in a usage cycle before the job counter resets. */
export const CYCLE_DAYS = 30;

/**
 * Line-items at or below which a job runs inline as batched mutations instead
 * of going through Bulk Operations.
 *
 * Bulk Operations are strictly better above this — no rate-limit pain, one
 * request — but they are asynchronous, so a 12-row edit would sit "running"
 * for the tens of seconds Shopify takes to schedule the operation. Below the
 * threshold, inline mutations finish before the merchant's page reloads.
 */
export const SYNC_ITEM_LIMIT = 100;

/** Variants per `productVariantsBulkUpdate` call on the inline path (SPEC §5). */
export const VARIANTS_PER_MUTATION = 10;

// --- naming -----------------------------------------------------------------

const MONEY_OP: Record<string, string> = {
  set: "→",
  increase: "+",
  decrease: "−",
};

/**
 * A short human summary of an action stack: "Price −15%, add tag sale".
 *
 * Used for the auto-generated job name, so it has to survive being read months
 * later in a history list next to an Undo button.
 */
export function describeActions(actions: EditAction[]): string {
  const parts = actions.map((action) => {
    switch (action.type) {
      case "price": {
        const field = action.field === "price" ? "Price" : "Compare at";
        const unit = action.unit === "percent" ? "%" : "";
        const amount = action.amount || "0";
        return action.op === "set"
          ? `${field} → ${amount}`
          : `${field} ${MONEY_OP[action.op]}${amount}${unit}`;
      }
      case "tags": {
        const list = action.tags.join(", ");
        if (action.op === "add") return `add tag ${list}`;
        if (action.op === "remove") return `remove tag ${list}`;
        return list ? `replace tags with ${list}` : "clear tags";
      }
      case "status":
        return `set ${action.value.toLowerCase()}`;
      default:
        return "edit";
    }
  });
  return parts.join(", ") || "Bulk edit";
}

/** Full auto-name: the actions, plus what they were applied to. */
export function jobName(actions: EditAction[], scopeLabel: string): string {
  const summary = describeActions(actions);
  const name = scopeLabel ? `${summary} on ${scopeLabel}` : summary;
  // The column is unbounded, but a name that doesn't fit a table cell is not a
  // name. Truncate here so every surface gets the same string.
  return name.length > 120 ? `${name.slice(0, 117)}…` : name;
}

export function undoJobName(originalName: string): string {
  return `Undo: ${originalName}`.slice(0, 120);
}

/**
 * Display name for a `Snapshot.fieldPath`.
 *
 * Falls back to the path itself rather than throwing: v1.1 adds paths like
 * `metafield.custom.material`, and a job page from the future rendering
 * "metafield.custom.material" is better than one that crashes.
 */
export function fieldLabel(fieldPath: string): string {
  switch (fieldPath) {
    case "variant.price":
      return "Price";
    case "variant.compareAtPrice":
      return "Compare at price";
    case "product.tags":
      return "Tags";
    case "product.status":
      return "Status";
    default:
      return fieldPath;
  }
}
