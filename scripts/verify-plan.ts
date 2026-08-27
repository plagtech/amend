/**
 * Proves the plan gates are gates — server-side, in the functions the routes
 * call, not in the buttons the browser draws.
 *
 *   npm run verify:plan
 *
 * Every check here goes through the same entry points the app uses:
 * `createApplyJob`, `saveTemplate`, `openTemplate`, `createUndoJob`. Nothing is
 * asserted about the UI, because the UI is not the gate: a merchant with the
 * network tab open can post whatever they like, and these are the functions
 * that have to say no.
 *
 * Touches Postgres only — no catalog writes, no Shopify calls, seconds to run.
 */

import process from "node:process";

import db from "../app/db.server";
import type { EditAction } from "../app/lib/actions";
import { emptyMatch } from "../app/lib/actions";
import { createApplyJob, createUndoJob } from "../app/lib/apply.server";
import {
  PlanLimitError,
  assertActionsAllowed,
  usableTemplateIds,
} from "../app/lib/billing.server";
import { emptyFilters } from "../app/lib/filters";
import { FREE_JOB_LIMIT, FREE_TEMPLATE_LIMIT } from "../app/lib/jobs";
import type { JobScope } from "../app/lib/snapshots.server";
import {
  TemplateError,
  listTemplates,
  openTemplate,
  saveTemplate,
} from "../app/lib/templates.server";
import {
  assertTrue,
  check,
  expectError,
  loadEnvFile,
  report,
} from "./harness";

/** A shop of our own, so a real store's plan and templates are never touched. */
const SHOP = "amend-verify-plan.myshopify.test";

const PLAIN: EditAction[] = [
  { type: "tags", op: "add", tags: ["sale"], match: emptyMatch() },
];

const REGEX: EditAction[] = [
  {
    type: "text",
    field: "title",
    op: "replace",
    match: {
      find: "^(\\w+)",
      replaceWith: "$1!",
      caseSensitive: false,
      regex: true,
    },
    value: "",
  },
];

const SCOPE: JobScope = {
  filters: emptyFilters(),
  selection: { mode: "some", ids: ["gid://shopify/Product/1"] },
  excluded: [],
  sortKey: "TITLE",
  reverse: false,
};

let keySeed = 0;
const nextKey = () => `verify-plan-${Date.now()}-${(keySeed += 1)}`;

async function setPlan(plan: "free" | "pro", jobsThisMonth = 0): Promise<void> {
  await db.shop.upsert({
    where: { id: SHOP },
    create: { id: SHOP, plan, jobsThisMonth, cycleStart: new Date() },
    update: { plan, jobsThisMonth, cycleStart: new Date() },
  });
}

async function jobsUsed(): Promise<number> {
  return (await db.shop.findUnique({ where: { id: SHOP } }))?.jobsThisMonth ?? 0;
}

async function main(): Promise<void> {
  loadEnvFile();
  if (!process.env.DATABASE_URL) {
    console.error("Set DATABASE_URL in .env.");
    process.exit(1);
  }

  await reset();

  try {
    // --- the monthly quota -------------------------------------------------
    console.log("Quota — the free plan's monthly allowance:");
    await setPlan("free", FREE_JOB_LIMIT - 1);

    const last = await createApplyJob({
      shopId: SHOP,
      name: "verify: the last free edit",
      scope: SCOPE,
      actions: PLAIN,
      idempotencyKey: nextKey(),
    });
    check("the last edit inside the allowance is accepted", last.status, "queued");
    check("it spent a credit", await jobsUsed(), FREE_JOB_LIMIT);

    await expectError(
      "the next one is refused server-side, in createApplyJob",
      () =>
        createApplyJob({
          shopId: SHOP,
          name: "verify: one too many",
          scope: SCOPE,
          actions: PLAIN,
          idempotencyKey: nextKey(),
        }),
      (message) =>
        message.includes(`all ${FREE_JOB_LIMIT} bulk edits`) &&
        message.includes("Undo stays available"),
    );
    check("the refusal spent nothing", await jobsUsed(), FREE_JOB_LIMIT);
    check(
      "and queued nothing",
      await db.editJob.count({ where: { shopId: SHOP, status: "queued" } }),
      1,
    );

    // Undo is the promise the product is sold on: it works at the limit, on
    // the free plan, and costs nothing (SPEC §7).
    const applied = await db.editJob.create({
      data: {
        shopId: SHOP,
        name: "verify: a finished edit",
        status: "completed",
        totalItems: 1,
        filterJson: {},
        actionsJson: PLAIN as never,
      },
    });
    await db.snapshot.create({
      data: {
        jobId: applied.id,
        ownerGid: "gid://shopify/Product/1",
        productGid: "gid://shopify/Product/1",
        fieldPath: "product.tags",
        oldValue: JSON.stringify([]),
        newValue: JSON.stringify(["sale"]),
        applied: true,
      },
    });
    const undo = await createUndoJob(SHOP, applied.id);
    check("undo still works at the limit", undo.status, "queued");
    check("undo consumed no credit", await jobsUsed(), FREE_JOB_LIMIT);

    check(
      "and Pro is not stopped by the same counter",
      (
        await (async () => {
          await setPlan("pro", FREE_JOB_LIMIT * 3);
          return createApplyJob({
            shopId: SHOP,
            name: "verify: pro edit",
            scope: SCOPE,
            actions: PLAIN,
            idempotencyKey: nextKey(),
          });
        })()
      ).status,
      "queued",
    );

    // --- regex -------------------------------------------------------------
    console.log("\nRegex — a Pro feature, refused on the write path:");
    await setPlan("free");

    await expectError(
      "a regex action is refused by the shared gate",
      async () => assertActionsAllowed("free", REGEX),
      (message) => message.includes("Regular-expression"),
    );
    assertTrue(
      "the same gate lets a plain find & replace through",
      (() => {
        try {
          assertActionsAllowed("free", PLAIN);
          return true;
        } catch {
          return false;
        }
      })(),
    );
    await expectError(
      "and createApplyJob refuses it even with a valid preview key",
      () =>
        createApplyJob({
          shopId: SHOP,
          name: "verify: regex on free",
          scope: SCOPE,
          actions: REGEX,
          idempotencyKey: nextKey(),
        }),
      (message) => message.includes("Regular-expression"),
    );
    check("nothing was queued for it", await jobsUsed(), 0);

    await setPlan("pro");
    check(
      "Pro runs the same regex edit",
      (
        await createApplyJob({
          shopId: SHOP,
          name: "verify: regex on pro",
          scope: SCOPE,
          actions: REGEX,
          idempotencyKey: nextKey(),
        })
      ).status,
      "queued",
    );

    // --- templates ---------------------------------------------------------
    console.log("\nTemplates — the cap, and what a downgrade does to it:");
    await setPlan("pro");
    const saved = [];
    for (let i = 1; i <= FREE_TEMPLATE_LIMIT + 2; i += 1) {
      saved.push(
        await saveTemplate({
          shopId: SHOP,
          name: `verify template ${i}`,
          filters: emptyFilters(),
          actions: PLAIN,
        }),
      );
      // Ordering is by creation time, and these are created in the same
      // millisecond otherwise.
      await new Promise((done) => setTimeout(done, 5));
    }
    check(
      "Pro saves past the free cap",
      saved.length,
      FREE_TEMPLATE_LIMIT + 2,
    );

    await setPlan("free");
    await expectError(
      "a free shop cannot save another",
      () =>
        saveTemplate({
          shopId: SHOP,
          name: "verify: one template too many",
          filters: emptyFilters(),
          actions: PLAIN,
        }),
      (message) => message.includes(`${FREE_TEMPLATE_LIMIT} saved templates`),
    );

    const listed = await listTemplates(SHOP);
    check(
      "a downgrade deletes nothing",
      listed.length,
      FREE_TEMPLATE_LIMIT + 2,
    );
    check(
      "the oldest three stay runnable",
      listed.filter((template) => !template.locked).length,
      FREE_TEMPLATE_LIMIT,
    );
    assertTrue(
      "and it is the oldest three, not whichever three",
      listed
        .slice()
        .reverse()
        .slice(0, FREE_TEMPLATE_LIMIT)
        .every((template) => !template.locked),
    );

    const lockedTemplate = listed.find((template) => template.locked)!;
    const usableTemplate = listed.find((template) => !template.locked)!;
    assertTrue(
      "a locked template still lists what it would do",
      Boolean(lockedTemplate.summary) && Boolean(lockedTemplate.scope),
    );
    await expectError(
      "but running it is refused server-side, in openTemplate",
      () => openTemplate(SHOP, lockedTemplate.id),
      (message) => message.includes("read-only") || message.includes("kept and readable"),
    );
    assertTrue(
      "a usable one still opens",
      (await openTemplate(SHOP, usableTemplate.id)).startsWith("/app/edit/new?"),
    );

    await setPlan("pro");
    check(
      "upgrading unlocks every one of them again",
      (await listTemplates(SHOP)).filter((template) => template.locked).length,
      0,
    );

    // The allowance itself, as a pure function — the ordering rule stated once.
    check(
      "the allowance is the oldest N, deterministically",
      [
        ...usableTemplateIds(
          "free",
          [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
          3,
        ),
      ],
      ["a", "b", "c"],
    );
  } finally {
    await reset();
    await db.$disconnect();
  }

  report();
}

/** This shop is entirely ours; leaving rows behind would corrupt a re-run. */
async function reset(): Promise<void> {
  const jobs = await db.editJob.findMany({
    where: { shopId: SHOP },
    select: { id: true },
  });
  await db.snapshot.deleteMany({
    where: { jobId: { in: jobs.map((job) => job.id) } },
  });
  await db.editJob.deleteMany({ where: { shopId: SHOP } });
  await db.savedTemplate.deleteMany({ where: { shopId: SHOP } });
  await db.shop.deleteMany({ where: { id: SHOP } });
}

main().catch(async (error) => {
  console.error(`\nVerification failed: ${(error as Error).message}`);
  await reset().catch(() => {});
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
