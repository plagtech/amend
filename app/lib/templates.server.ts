/**
 * Saved edit templates (SPEC §3.7, §6, §7).
 *
 * A template is a filter plus an action stack, stored exactly as a job stores
 * them — `SavedTemplate.filterJson` is a serialized `SelectFilters` and
 * `actionsJson` is the same array `EditJob.actionsJson` holds. That is what lets
 * "run" be a plain link back into the wizard with the criteria pre-filled, and
 * what lets a finished job be saved as a template without translating anything.
 *
 * A template deliberately does not carry a selection. The whole point of saving
 * one is to run it again later against whatever matches *then* — a frozen list
 * of product IDs would go stale the first time the catalog changed, and it would
 * quietly edit products the merchant no longer means to include.
 */

import type { SavedTemplate } from "@prisma/client";

import db from "../db.server";
import type { EditAction } from "./actions";
import { parseActions, serializeActions } from "./actions";
import { planFor, usableTemplateIds } from "./billing.server";
import { FREE_TEMPLATE_LIMIT, describeActions } from "./jobs";
import type { SelectFilters } from "./filters";
import { parseFilters, serializeFilters } from "./filters";

/** A template could not be saved. Shown to the merchant as-is. */
export class TemplateError extends Error {}

/** The most templates one shop can hold, whatever the plan. A sanity ceiling. */
const HARD_LIMIT = 200;

export interface SaveTemplateArgs {
  shopId: string;
  name: string;
  filters: SelectFilters;
  actions: EditAction[];
}

export async function saveTemplate({
  shopId,
  name,
  filters,
  actions,
}: SaveTemplateArgs): Promise<SavedTemplate> {
  const trimmed = name.trim().slice(0, 80);
  if (!trimmed) throw new TemplateError("Give this template a name.");
  if (!actions.length) {
    throw new TemplateError("Add at least one edit action before saving.");
  }

  const shop = await db.shop.upsert({
    where: { id: shopId },
    create: { id: shopId },
    update: {},
  });
  const count = await db.savedTemplate.count({ where: { shopId } });

  // Plan gating proper lands with billing in Phase 6; the allowance itself is
  // enforced here from the day templates exist, so a free shop cannot quietly
  // accumulate a hundred of them and then be told they are gone.
  if (shop.plan === "free" && count >= FREE_TEMPLATE_LIMIT) {
    throw new TemplateError(
      `The free plan keeps ${FREE_TEMPLATE_LIMIT} saved templates. Delete one, or upgrade for unlimited.`,
    );
  }
  if (count >= HARD_LIMIT) {
    throw new TemplateError("You have reached the maximum number of templates.");
  }

  return db.savedTemplate.create({
    data: {
      shopId,
      name: trimmed,
      filterJson: serializeFilters(filters).toString(),
      actionsJson: serializeActions(actions),
    },
  });
}

export async function deleteTemplate(
  shopId: string,
  id: string,
): Promise<void> {
  // Scoped by shop, not just by id: a template id from another shop must not be
  // deletable by guessing it.
  await db.savedTemplate.deleteMany({ where: { id, shopId } });
}

export interface TemplateView {
  id: string;
  name: string;
  /** "Price −15%, add tag sale" — the same summary a job's name is built from. */
  summary: string;
  /** Human-readable filter, e.g. "Vendor: Atlas Goods · Tag: summer". */
  scope: string;
  /** Link that opens the wizard with this template's filter and actions loaded. */
  href: string;
  createdAt: string;
  /**
   * True when the shop's plan no longer covers this template.
   *
   * Read-only, not gone: it still lists, still shows what it would do, and
   * comes back the moment the shop upgrades or deletes enough to fit under the
   * cap (SPEC §7). Enforced by `openTemplate`, not by hiding the button.
   */
  locked: boolean;
}

/**
 * Templates for one shop, oldest last, ready to render.
 *
 * The href is built here rather than in the browser because it is the same
 * serialization the wizard's own URL uses — one function owns the shape of that
 * link, and it is the server-side one that already has `filterJson` parsed.
 */
export async function listTemplates(shopId: string): Promise<TemplateView[]> {
  const rows = await db.savedTemplate.findMany({
    where: { shopId },
    orderBy: { createdAt: "desc" },
  });

  // Which ones the plan still covers. Computed from oldest first, so the answer
  // does not shuffle when a template is added or deleted.
  const usable = usableTemplateIds(
    await planFor(shopId),
    [...rows].reverse(),
    FREE_TEMPLATE_LIMIT,
  );

  return rows.map((row) => {
    const filters = parseFilters(new URLSearchParams(readString(row.filterJson)));
    const actions = parseActions(readString(row.actionsJson));
    const params = serializeFilters(filters);
    if (actions.length) params.set("actions", serializeActions(actions));

    return {
      id: row.id,
      name: row.name,
      summary: actions.length ? describeActions(actions) : "No actions",
      scope: describeFilters(filters),
      href: `/app/edit/new?${params.toString()}`,
      createdAt: row.createdAt.toISOString(),
      locked: !usable.has(row.id),
    };
  });
}

/**
 * Resolve a template into the wizard link that runs it — or refuse.
 *
 * This exists so that "you can view it but not run it" is a server-side fact.
 * The Use button posts here rather than linking straight to the wizard, because
 * a link is not a gate: anyone can type the URL. The refusal is the same shape
 * as every other plan refusal, so the page can show the message it comes with.
 */
export async function openTemplate(
  shopId: string,
  templateId: string,
): Promise<string> {
  const templates = await listTemplates(shopId);
  const template = templates.find((entry) => entry.id === templateId);
  if (!template) throw new TemplateError("That template no longer exists.");
  if (template.locked) {
    throw new TemplateError(
      `The free plan runs ${FREE_TEMPLATE_LIMIT} saved templates. This one is kept and readable — upgrade, or delete a newer template, to run it again.`,
    );
  }
  return template.href;
}

/**
 * Prisma `Json` columns come back as whatever was written. Templates store both
 * blobs as strings, but a row written by hand — or by a future version — could
 * hold an object, and a template list is not worth crashing a page over.
 */
function readString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return JSON.stringify(value);
  return "";
}

/** A short, readable account of what a template is aimed at. */
function describeFilters(filters: SelectFilters): string {
  const parts: string[] = [];
  if (filters.search) parts.push(`"${filters.search}"`);
  if (filters.collectionId) parts.push("A collection");
  if (filters.vendors.length) parts.push(`Vendor: ${filters.vendors.join(", ")}`);
  if (filters.productTypes.length) {
    parts.push(`Type: ${filters.productTypes.join(", ")}`);
  }
  if (filters.tags.length) parts.push(`Tag: ${filters.tags.join(", ")}`);
  if (filters.statuses.length) parts.push(`Status: ${filters.statuses.join(", ")}`);
  if (filters.skuPrefix) parts.push(`SKU: ${filters.skuPrefix}*`);
  if (filters.priceMin || filters.priceMax) {
    parts.push(`Price ${filters.priceMin || "0"}–${filters.priceMax || "∞"}`);
  }
  if (filters.inventoryMin || filters.inventoryMax) {
    parts.push(
      `Inventory ${filters.inventoryMin || "0"}–${filters.inventoryMax || "∞"}`,
    );
  }
  if (filters.view === "variant") parts.push("Variant view");
  return parts.join(" · ") || "Every product";
}
