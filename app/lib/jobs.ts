/**
 * Job vocabulary shared by the engine and the pages that render it.
 *
 * Isomorphic, like `filters.ts` and `actions.ts`: the dashboard and the job
 * page render statuses from here, and `apply.server.ts` transitions between the
 * same strings. Keeping them in one place is what stops a status the UI has no
 * label for from ever reaching the database.
 */

import type { EditAction } from "./actions";
import { WEIGHT_UNIT_LABEL } from "./actions";

/**
 * A job's lifecycle.
 *
 *   draft         created but not submitted (unused in v1 — the wizard submits
 *                 straight to `queued`; reserved for saved jobs)
 *   scheduled     accepted, waiting for its `scheduledFor` time. Deliberately
 *                 its own status rather than a `queued` job with a date: the
 *                 drain and the stale sweep both hunt for `queued`, and a job
 *                 due next Tuesday must be invisible to them until it is due
 *   queued        accepted, waiting for the shop's run slot
 *   snapshotting  resolving the selection and persisting before-values
 *   running       snapshots are complete and durable; mutations are in flight
 *   completed     every row was attempted (check `failedItems` for partials)
 *   failed        the job could not run, or every row failed
 *   undone        an undo job has since restored this job's before-values
 *   cancelled     a scheduled job the merchant called off before it fired. Kept
 *                 rather than deleted: "what happened to that sale I set up?"
 *                 deserves an answer, and it never wrote anything to answer for
 */
export const JOB_STATUSES = [
  "draft",
  "scheduled",
  "queued",
  "snapshotting",
  "running",
  "completed",
  "failed",
  "undone",
  "cancelled",
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
  return (
    status === "completed" ||
    status === "failed" ||
    status === "undone" ||
    status === "cancelled"
  );
}

/** A job that has not run yet and can still be called off. */
export function isPending(status: string): boolean {
  return status === "scheduled";
}

export function jobStatusLabel(status: string, failedItems = 0): string {
  switch (status) {
    case "draft":
      return "Draft";
    case "scheduled":
      return "Scheduled";
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
    case "cancelled":
      return "Cancelled";
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
    case "scheduled":
      return "info";
    default:
      return undefined;
  }
}

/** Free plan allowance. Undo never counts against it — see SPEC §7. */
export const FREE_JOB_LIMIT = 10;

/** Saved edit templates on the free plan (SPEC §7). Pro is unlimited. */
export const FREE_TEMPLATE_LIMIT = 3;

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

/** Job-name wording for each text target. Lower case: these read mid-sentence. */
const TEXT_FIELD_LABEL: Record<string, string> = {
  title: "title",
  description: "description",
  seoTitle: "SEO title",
  seoDescription: "SEO description",
  vendor: "vendor",
  productType: "type",
};

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
        if (action.op === "findReplace") {
          return `tags "${action.match.find}" → "${action.match.replaceWith}"`;
        }
        return list ? `replace tags with ${list}` : "clear tags";
      }
      case "status":
        return `set ${action.value.toLowerCase()}`;
      case "text": {
        const field = TEXT_FIELD_LABEL[action.field];
        switch (action.op) {
          case "replace":
            return `${field} "${action.match.find}" → "${action.match.replaceWith}"`;
          case "append":
            return `append to ${field}`;
          case "prepend":
            return `prepend to ${field}`;
          case "set":
            return action.value
              ? `${field} → ${action.value}`
              : `clear ${field}`;
        }
        return `edit ${field}`;
      }
      case "inventory":
        if (action.field === "tracked") {
          return action.value ? "track quantity" : "stop tracking quantity";
        }
        return action.value
          ? "continue selling when out of stock"
          : "stop selling when out of stock";
      case "variantText": {
        const field = action.field === "sku" ? "SKU" : "barcode";
        if (action.op === "replace") {
          return `${field} "${action.match.find}" → "${action.match.replaceWith}"`;
        }
        return action.op === "clear"
          ? `clear ${field}`
          : `${field} → ${action.value}`;
      }
      case "weight":
        return action.op === "convert"
          ? `weight in ${WEIGHT_UNIT_LABEL[action.unit]}`
          : `weight → ${action.value || "0"} ${WEIGHT_UNIT_LABEL[action.unit]}`;
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
    case "variant.inventoryPolicy":
      return "When out of stock";
    case "variant.inventoryItem.tracked":
      return "Track quantity";
    case "variant.inventoryItem.sku":
      return "SKU";
    case "variant.barcode":
      return "Barcode";
    case "variant.inventoryItem.measurement.weight":
      return "Weight";
    case "product.tags":
      return "Tags";
    case "product.status":
      return "Status";
    case "product.title":
      return "Title";
    case "product.descriptionHtml":
      return "Description";
    case "product.vendor":
      return "Vendor";
    case "product.productType":
      return "Product type";
    case "product.seo.title":
      return "SEO title";
    case "product.seo.description":
      return "SEO description";
    default:
      return fieldPath;
  }
}
