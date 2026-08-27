/**
 * Billing (SPEC §7): one paid plan, Shopify's Billing API, and a `Shop.plan`
 * column that every server-side gate reads.
 *
 * ## Why the Billing API and not Managed Pricing
 *
 * Both were on the table for a single $19/month plan, and Managed Pricing is
 * the one Shopify pushes for App Store apps — it hosts the plan picker, handles
 * upgrades and trials, and puts the price on the listing. We use the Billing
 * API (`appSubscriptionCreate`, through `shopify-app-remix`'s helpers) anyway,
 * for three reasons:
 *
 *   1. **It is verifiable from this repo.** Managed Pricing plans are created
 *      in the Partner Dashboard and cannot be defined, read back, or asserted
 *      from code. `npm run verify:billing` drives the real subscription against
 *      the dev store with a test charge; a price that only exists in a dashboard
 *      is a price no test can check.
 *   2. **The plan lives next to the gates it drives.** `PRO_PLAN` below is the
 *      same constant the quota, template and regex checks read. With Managed
 *      Pricing the repo would describe an allowance whose price it neither sets
 *      nor knows.
 *   3. **The surface we need is tiny.** One plan, one interval, no usage
 *      charges: `request`, `check`, `cancel`. Managed Pricing's value is in the
 *      cases we do not have (plan matrices, migrations between tiers).
 *
 * Moving to Managed Pricing later is a listing-side change, not a rewrite: the
 * read path is `currentAppInstallation.activeSubscriptions` either way, which is
 * exactly what `syncPlan` below reads. Nothing here would be thrown away.
 *
 * ## Where the plan is authoritative
 *
 * `Shop.plan` in Postgres. Every gate is server-side and reads that column, so
 * a gate never depends on a Shopify round-trip being fast, or on the browser
 * being honest. It is kept true by three things: the `app_subscriptions/update`
 * webhook (the moment a subscription activates, is cancelled, declined, frozen
 * or expires), a sync when the merchant lands back from the approval page, and
 * a sync whenever the settings page is opened.
 */

import db from "../db.server";
import type { EditAction } from "./actions";

/** The one paid plan. The key is also what `billing.request({ plan })` takes. */
export const PRO_PLAN = "Amend Pro";

export const PRO_PRICE = 19;
export const PRO_CURRENCY = "USD";
export const PRO_TRIAL_DAYS = 7;

export type Plan = "free" | "pro";

/**
 * Subscription statuses that mean the merchant is paying (or is inside a trial
 * they agreed to). Everything else — CANCELLED, DECLINED, EXPIRED, FROZEN,
 * PENDING — is free, including FROZEN: a frozen subscription is one Shopify has
 * suspended for non-payment, and continuing to hand out paid features on it
 * would be a decision we never made.
 */
const PAID_STATUSES = new Set(["ACTIVE", "ACCEPTED"]);

export function isPaidStatus(status: string | null | undefined): boolean {
  return PAID_STATUSES.has(String(status ?? "").toUpperCase());
}

/** What the settings page and the verification script both want to know. */
export interface PlanState {
  plan: Plan;
  /** The live subscription, when there is one. */
  subscriptionId: string | null;
  subscriptionName: string | null;
  status: string | null;
  test: boolean;
  /** ISO date the current period ends, when Shopify reports one. */
  currentPeriodEnd: string | null;
  trialDays: number;
}

export const FREE_STATE: PlanState = {
  plan: "free",
  subscriptionId: null,
  subscriptionName: null,
  status: null,
  test: false,
  currentPeriodEnd: null,
  trialDays: 0,
};

/**
 * Write the plan Shopify reports into `Shop.plan`.
 *
 * Takes the already-fetched subscription list rather than fetching it, so the
 * webhook (which is handed one subscription) and the loaders (which check all
 * of them) share one place that decides what counts as paid.
 */
/**
 * The parts of a subscription this app cares about.
 *
 * Structural rather than Shopify's own `AppSubscription`, because three
 * different shapes arrive here — the billing helper's objects, a webhook
 * payload, and a raw GraphQL response in the verification script — and every
 * one of them carries these fields under these names.
 */
export interface SubscriptionLike {
  id?: string | null;
  name?: string | null;
  status?: string | null;
  test?: boolean | null;
  currentPeriodEnd?: string | null;
  trialDays?: number | null;
}

export async function syncPlan(
  shopId: string,
  subscriptions: SubscriptionLike[],
): Promise<PlanState> {
  const paid = subscriptions.find((subscription) =>
    isPaidStatus(subscription.status),
  );
  const plan: Plan = paid ? "pro" : "free";

  await db.shop.upsert({
    where: { id: shopId },
    create: { id: shopId, plan },
    update: { plan },
  });

  if (!paid) return FREE_STATE;

  return {
    plan,
    subscriptionId: paid.id ?? null,
    subscriptionName: paid.name ?? null,
    status: paid.status ?? null,
    test: Boolean(paid.test),
    currentPeriodEnd: paid.currentPeriodEnd ?? null,
    trialDays: paid.trialDays ?? 0,
  };
}

/** The plan as the gates see it. Never calls Shopify — this is the gate's truth. */
export async function planFor(shopId: string): Promise<Plan> {
  const shop = await db.shop.findUnique({
    where: { id: shopId },
    select: { plan: true },
  });
  return shop?.plan === "pro" ? "pro" : "free";
}

// --- the gates --------------------------------------------------------------

/**
 * A plan allowance was reached. Carries a message written for the merchant, so
 * every caller can surface it verbatim rather than inventing its own wording.
 *
 * Defined here, next to the plans, and re-exported by `apply.server.ts` where
 * most callers already look for it.
 */
export class PlanLimitError extends Error {}

/**
 * Regex find & replace is a Pro feature (SPEC §7).
 *
 * Enforced here rather than by hiding the checkbox: the preview endpoint and
 * the apply endpoint both take actions straight off the wire, so a browser that
 * simply posts `regex: true` has to be refused by the server or the feature is
 * not gated at all. Called from both.
 */
export function assertActionsAllowed(plan: Plan, actions: EditAction[]): void {
  if (plan === "pro") return;
  const usesRegex = actions.some(
    (action) =>
      (action.type === "text" ||
        action.type === "tags" ||
        action.type === "variantText") &&
      action.match.regex,
  );
  if (usesRegex) {
    throw new PlanLimitError(
      "Regular-expression find & replace is part of Pro. Upgrade, or turn Regex off to run this as a plain find & replace.",
    );
  }
}

/**
 * Templates a free shop may still run, oldest first.
 *
 * A downgrade never deletes a template (SPEC §7). The ones past the allowance
 * become read-only: still listed, still readable, not runnable until the shop
 * upgrades or deletes enough to come back under the cap. Oldest-first is what
 * makes that stable — which three are live does not change when a fourth is
 * added or a fifth is deleted.
 */
export function usableTemplateIds(
  plan: Plan,
  templatesOldestFirst: { id: string }[],
  limit: number,
): Set<string> {
  const usable =
    plan === "pro" ? templatesOldestFirst : templatesOldestFirst.slice(0, limit);
  return new Set(usable.map((template) => template.id));
}

/**
 * Force a shop back to the free plan.
 *
 * Used by the `app_subscriptions/update` webhook when a subscription stops
 * being paid, and by uninstall. Deliberately does not touch templates or jobs:
 * SPEC §7 — a downgrade lowers what a merchant can *start*, it never deletes
 * what they already have.
 */
export async function downgradeToFree(shopId: string): Promise<void> {
  await db.shop.updateMany({ where: { id: shopId }, data: { plan: "free" } });
}
