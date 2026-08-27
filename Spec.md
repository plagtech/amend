# SPEC: "Amend" — Shopify Bulk Product Editor
### Build specification for Claude Code
**Owner:** plagtech · **Target:** Shopify App Store submission in 2 weeks
**Name:** Amend · **App Store listing name:** "Amend ‑ Bulk Product Editor" · **App handle:** `amend` (fallback: `amend-bulk-editor`)
**Brand voice:** careful, reversible, trustworthy — "the bulk editor that never breaks your catalog"

---

## 1. Product Summary

An embedded Shopify admin app that lets merchants filter products/variants, preview changes, apply bulk edits via Shopify's Bulk Operations GraphQL API, and undo any edit with one click. Positioning: **"The bulk editor that never breaks your catalog."** Fast, multi-field, reliable undo, generous free tier.

### Competitive wedge (mined from competitor 1-2 star reviews — these are the requirements)
1. **Multi-field edits in one task.** Competitors force one field per task (Sami downgraded to this; merchants complained). We allow editing price + tags + status + anything else in a single job.
2. **Reliable, always-free undo.** Competitors gate revert behind paid plans or have it silently fail. Every job stores a full before-snapshot; undo is one click, free forever, retained 90 days.
3. **No 50-product paywall trap.** EasyBy caps free at 50 products — top complaint. Our free tier: unlimited products per edit, capped at 10 jobs/month instead.
4. **Speed.** Competitors are "slow from time to time." Use Bulk Operations API (async, no rate-limit pain) + optimistic UI + progress streaming.
5. **Variant-level targeting.** Merchants asked for selecting specific variants, not just products. First-class support.
6. **Real find/replace in descriptions.** Competitors only support "add text to beginning/end." We support find/replace (plain + regex mode behind an "advanced" toggle).
7. **Saved filters & recurring/scheduled edits.** Merchants schedule weekly sales toggles manually. Saved edit templates + scheduling = retention.
8. **Preview before apply.** Table of exact before → after values, with per-row exclude checkboxes. (This is the single most-praised feature in positive competitor reviews.)

---

## 2. Tech Stack

- **Framework:** Shopify Remix app template (`npm init @shopify/app@latest` — select Remix, JavaScript or TS, TS preferred). Same pattern as Spraay Batch Payouts, so reuse learnings.
- **UI:** Shopify **Polaris** web components + App Bridge. Do NOT build custom design system — Polaris is what makes embedded apps feel native and passes "Built for Shopify" design review. "Well done yet simple" = disciplined Polaris usage (IndexTable, Filters, Page, Card, Banner, ProgressBar, Modal).
- **DB:** Postgres on Railway (Prisma ORM — ships with the template using SQLite; swap datasource to Postgres).
- **Queue/scheduler:** BullMQ + Redis on Railway (for scheduled edits + polling bulk op status). Keep it simple — one worker process.
- **Hosting:** Railway (app + worker + Postgres + Redis).
- **Shopify APIs:** Admin GraphQL API (2025-07 or latest stable). Key surfaces:
  - `bulkOperationRunQuery` — export current product state for previews/snapshots at scale
  - `bulkOperationRunMutation` + staged upload (JSONL) — apply edits at scale
  - `productVariantsBulkUpdate`, `productUpdate`, `tagsAdd`/`tagsRemove` — for small jobs (< ~100 items) run synchronously in batched mutations for instant feel; use Bulk Operations above that threshold
  - `webhookSubscriptions` for `bulk_operations/finish` — no polling needed for job completion
- **Scopes:** `read_products`, `write_products`. Nothing else. Minimal scopes = faster review.

---

## 3. Core User Flow (the whole app is this loop)

```
SELECT → EDIT → PREVIEW → APPLY → (UNDO)
```

1. **Select** — Filter products: collection, vendor, product type, tag, status, title contains, price range, SKU contains, inventory qty, created/updated date. Toggle: product-level or variant-level results. Results in a Polaris IndexTable with checkboxes, "select all matching filter" (not just current page).
2. **Edit** — "Add action" button; stack multiple actions in one job:
   - **Price:** set / increase / decrease by % or fixed; round to .99/.95/.00; also compare-at price; also cost per item
   - **Tags:** add / remove / replace
   - **Status:** active / draft / archived (+ schedule both directions = sale windows)
   - **Title / Description:** find & replace (plain match default, case-sensitive toggle, regex behind Advanced toggle); append / prepend
   - **Inventory quantity is deliberately not editable, in any phase** — see the Phase 5 note in §9. Everything else here restores exactly on undo; a quantity does not.
   - **SEO:** meta title / description find-replace and templating (`{{title}} | {{vendor}}` style tokens)
   - **Inventory:** track/untrack, continue selling when out of stock toggle
   - **Vendor / product type:** set value
   - **Weight (variant), barcode, SKU:** find/replace or set
3. **Preview** — Server computes before → after for every affected row. Show diff table (old value struck through → new value). Per-row exclude checkbox. Summary banner: "312 products · 894 variants will change." Nothing writes until "Apply."
4. **Apply** — Job created; snapshot of all "before" values persisted first (this IS the undo data); then mutations run. Live progress bar (App Bridge toast + job page). On completion: success banner with count + "Undo" button.
5. **Undo** — One click reverses the job by applying the snapshot. Undo jobs are themselves jobs (visible in history). Partial-failure handling: report exactly which items failed and why, offer retry of failures only.

---

## 4. Data Model (Prisma)

```prisma
model Session { /* from Shopify template, unchanged */ }

model Shop {
  id            String   @id            // shop domain
  plan          String   @default("free") // free | pro
  jobsThisMonth Int      @default(0)
  cycleStart    DateTime @default(now())
  createdAt     DateTime @default(now())
}

model EditJob {
  id           String   @id @default(cuid())
  shopId       String
  name         String                     // auto: "Price -10% on Summer collection"
  filterJson   Json                       // the SELECT criteria
  actionsJson  Json                       // ordered list of edit actions
  status       String   @default("draft") // draft|previewing|snapshotting|running|completed|failed|undone
  scheduledFor DateTime?
  revertAt     DateTime?                  // optional auto-revert (sale windows)
  totalItems   Int      @default(0)
  failedItems  Int      @default(0)
  bulkOpGid    String?                    // Shopify bulk operation ID
  undoOfJobId  String?                    // set if this job is an undo
  createdAt    DateTime @default(now())
  completedAt  DateTime?
  snapshots    Snapshot[]
  idempotencyKey String? @unique          // minted with the preview, spent by Apply
  updatedAt    DateTime @updatedAt        // lets the sweep see an orphaned queued job
}

model Snapshot {
  id        String @id @default(cuid())
  jobId     String
  ownerGid  String  // product or variant GID
  fieldPath String  // e.g. "variant.price", "product.tags"
  oldValue  String  // JSON-encoded
  newValue  String
  applied   Boolean @default(false)
  error     String?
  job       EditJob @relation(fields: [jobId], references: [id])
  @@index([jobId])
}

model SavedTemplate {
  id          String @id @default(cuid())
  shopId      String
  name        String
  filterJson  Json
  actionsJson Json
  createdAt   DateTime @default(now())
}
```

Snapshot retention: cron deletes snapshots > 90 days old (free) / > 365 days (pro).

---

## 5. Job Engine (the only hard part — build carefully)

**Small jobs (≤100 line-items):** run inline via batched GraphQL mutations (10 variants per `productVariantsBulkUpdate` call), respect cost-based rate limits with a simple token bucket, stream progress via polling the job record.

**Large jobs (>100):**
1. `bulkOperationRunQuery` to export current values of affected fields → parse JSONL → write Snapshots.
2. Build mutation JSONL, `stagedUploadsCreate`, upload, `bulkOperationRunMutation`.
3. Subscribe to `bulk_operations/finish` webhook → parse result JSONL → mark per-row applied/error.
4. If Shopify bulk op fails wholesale, fall back to chunked sync mutations via BullMQ worker.

**Invariants:**
- Never begin mutations until 100% of snapshots are persisted. Undo integrity is the brand.
- Jobs are idempotent/resumable: each Snapshot row tracks `applied`, so a crashed worker resumes without double-applying.
- **Apply itself is idempotent, not just the rows inside it.** Every preview mints an `idempotencyKey`; the confirm POST sends it back and the unique index on `EditJob.idempotencyKey` turns a replayed confirm into a lookup of the job the first one created. This is not merely tidy — a duplicate job re-resolves the selection against the catalog the first job already changed, so a relative edit (price −10%) compounds and the duplicate's snapshot records the *discounted* price as its before-value, which takes two undos in the right order to unwind. A deliberate second application of the same edit still works: it goes through a second preview, and so a second key.
- Only one running job per shop at a time (queue others) — prevents conflicting edits and confusing undo semantics. Surface this in UI: "Queued behind: Price update (running)."
- If a product was modified externally between snapshot and undo, undo still applies the snapshot but flags the row: "value had changed since edit."

**Progress model — request-time only (accepted for now).** There is no cron, worker, or scheduler. A job moves only when something calls into the engine: a loader on the dashboard or a job page (both run `resumeStalledJobs`), the `bulk_operations/finish` webhook, or `drainQueue` running in-process behind a job that just finished. The sweep covers both shapes of stall — a job that was `snapshotting`/`running` and went quiet, and one orphaned in `queued` by a process that died before claiming the slot — but neither is noticed until somebody loads a page or a webhook lands. In practice this means a bulk job whose webhook never arrives waits for the merchant to come back and look at it. That is a deliberate trade for v1: it keeps the deploy a single web service. **A scheduled sweep is a Phase 6 item, alongside the Railway deploy work.**

**Known issue — `reconcileBulkJob` can be entered twice.** It is reachable from the `bulk_operations/finish` webhook and from the stale sweep with no claim between them, so a webhook arriving while a sweep-triggered reconcile is already in flight can run both concurrently. `settleBulkResults` is safe under this — it only touches rows that are still `applied: false, error: null` — but the `advanceBulk` call that follows is not: both entries can decide the same next stage still has pending rows and each call `startBulkStage`, producing a duplicate `bulkOperationRunMutation` for that stage and a `bulkOpGid` on the job that points at whichever wrote last, orphaning the other operation's results. Rows already applied are not re-sent and the mutations are absolute rather than relative, so the catalog outcome is not corrupted; the cost is a wasted bulk operation and a job that can strand rows waiting on a webhook for a GID it is no longer tracking. Fix is a claim around the reconcile, the same shape as `claimRunSlot`. Not addressed yet.

---

## 6. Pages (Remix routes)

| Route | Purpose |
|---|---|
| `/app` | Dashboard: recent jobs w/ status + undo buttons, "New bulk edit" CTA, usage meter (X/10 jobs this month on free) |
| `/app/edit/new` | The wizard: Filter panel → results IndexTable → Actions builder → Preview → Apply. Single page, progressive disclosure (Polaris `Layout` with steps), NOT a multi-route wizard. |
| `/app/jobs/:id` | Job detail: progress, per-row results, errors, undo, "re-run", "save as template" |
| `/app/templates` | Saved templates list; "run" pre-fills the wizard |
| `/app/settings` | Plan/billing, snapshot retention info |

**Design rules ("well done yet simple"):**
- Polaris defaults everywhere; zero custom CSS beyond spacing tweaks.
- One primary action per screen. The Apply button is disabled until preview has been generated — force the safe path.
- Destructive/irreversible states get Polaris `Banner` (critical) + confirm `Modal` showing the item count.
- Empty states with illustration + one CTA (Polaris `EmptyState`).
- Skeleton loading (`SkeletonBodyText`) — never spinners on full pages.
- Dark-launch nothing clever. Boring and instant beats novel.

---

## 7. Billing (Shopify Billing API — reuse Spraay's implementation pattern)

**Competitive anchor:** Ablestar (category leader, 4.9★) caps free at 10 products and charges $30/$60/$120 per month. EasyBy caps free at 50 products (top review complaint). Sami is free-forever at the bottom. Our position: a genuinely usable free tier (unlimited catalog size — beats both free-tier caps) and a paid tier at $19, 37% under the leader's entry price.

- **Free — $0:** unlimited products per edit, 10 jobs/month, undo always included (90-day retention), 3 saved templates.
- **Pro — $19/mo (7-day trial):** unlimited jobs, scheduling + auto-revert sale windows, unlimited templates, regex mode, 365-day undo retention, priority support.
- **Advanced — $49/mo (v1.1, do NOT build in v1):** reserved for metafield editing, automation rules, and recurring scheduled edits once reviews accumulate. Design plan-gating code so a third tier can be added without refactoring.

Pricing principle: do not go below $19 — in this category cheap signals fragile, and merchants are trusting the app with their entire catalog.
- Job counter resets on `cycleStart` + 30 days. Enforce server-side, show meter client-side. When free limit hit: Polaris banner with upgrade CTA — never block viewing history or **undo** (undo must ALWAYS work regardless of plan; this is a trust feature and a review-bait differentiator).

---

## 8. Compliance & Submission Checklist (same drill as Spraay Batch Payouts)

- [ ] Mandatory GDPR webhooks: `customers/data_request`, `customers/redact`, `shop/redact` (we store no customer data — respond 200, delete shop rows on shop/redact)
- [ ] `app/uninstalled` webhook → mark shop inactive, schedule data deletion
- [ ] Privacy policy at non-Railway custom domain (reuse the pattern/host from Spraay)
- [ ] App listing: name, 100-char tagline leading with "preview + one-click undo", 3-5 screenshots (dashboard, filter+table, preview diff, undo), demo video (Loom → YouTube)
- [ ] Test on dev store with 1,000+ product seed (write a seed script: `scripts/seed-products.ts` creating 1,000 products / 3,000 variants via Admin API)
- [ ] Session token auth throughout (no cookies), embedded app checks pass
- [ ] Lighthouse/perf: initial page < 2s (App Store reviews performance)

---

## 9. Build Order (phases for Claude Code — complete + verify each before next)

**Phase 1 — Scaffold (day 1):** Shopify Remix template, Postgres via Prisma, deploy to Railway, embedded app loads in dev store, GDPR + uninstall webhooks stubbed.

**Phase 2 — Select (days 2-3):** Filter panel + IndexTable with server-side product/variant search (GraphQL `products(query: ...)` syntax), pagination, select-all-matching, product/variant toggle.

**Phase 3 — Edit + Preview (days 4-6):** Actions builder (start with price, tags, status only), server-side diff computation, preview table with per-row exclude. **This is the demo-able core.**

**Phase 4 — Apply + Undo (days 7-9):** Snapshot engine, small-job sync path first, then Bulk Operations path, `bulk_operations/finish` webhook, undo. Test crash-resume.

**Phase 5 — Remaining actions (days 10-11):** title/description find-replace, SEO fields, inventory, vendor/type, SKU/barcode/weight. Templates page.

> **Built:** find & replace (plain, case toggle, regex) over title, description, vendor, product type and each tag; append/prepend/set on the same fields; SEO title and description with `{{title}}`/`{{vendor}}`/`{{type}}`/`{{handle}}`/`{{tags}}` templating; inventory tracking and out-of-stock policy; saved templates (list, save from the wizard or a finished job, run pre-fills the wizard, free-plan cap of 3).
>
> **Also built (second pass):** SKU (set + find/replace) and barcode (set + find/replace + clear), both written through `productVariantsBulkUpdate`; weight as a single `{value, unit}` value with set and exact unit conversion. A find/replace that would leave two variants in the selection sharing a SKU raises a warning row in the preview and applies anyway — Shopify allows duplicate SKUs and accepts them without a `userError`, so nothing else would ever mention it.
>
> **Not built — excluded by design, not deferred:**
> - **Inventory *quantity* adjustment.** A quantity is owned by fulfilment and moves on its own; an undo that restores yesterday's count over today's sales would be worse than no undo, so this is out of scope for v1 and beyond rather than waiting on a later phase. Track/untrack and the out-of-stock policy are settings, and settings restore cleanly. (Untracking makes Shopify discard the stocked quantity — undo restores the setting, not the numbers, and the builder says so.)
> - **Clearing a weight.** Shopify ignores `measurement: { weight: null }` outright, so a variant with no weight is left alone rather than given one that could not be taken back off.
>
> **Not built, deferred:** plan-gating for regex. The template allowance is enforced from day one; regex mode is built but ungated until billing lands in Phase 6.
>
> **Where the fields actually live (probed on 2026-07, not assumed).** `ProductVariantsBulkInput` has **no** `sku` — the SKU is read from `ProductVariant.sku` but written through `inventoryItem: { sku }`. `barcode` is on the variant input, and Shopify collapses `""` to `null`, so clearing records null and the snapshot preserves the distinction. Weight is read at `inventoryItem.measurement.weight { value unit }` and written as `inventoryItem: { measurement: { weight: { value, unit } } }` — `WeightInput` makes both halves non-null, which is the schema agreeing that it is one value.
>
> **Read cost.** Description, SEO and the variant `inventoryItem` are fetched only when an action touches them (`actionsNeedContent` / `actionsNeedInventory`), and the preview scan drops from 25 products per request to 10 when inventory comes along — `inventoryItem` is a nested object, so asking for it on 25×25 nodes lands past Shopify's 1,000-point ceiling and every page of the scan would be rejected. Shopify also rejects an omitted `Boolean!` variable even where the document declares a default for it, so both flags are sent on every request.

**Phase 6 — Billing + polish (days 12-13):** Billing API, plan gating, scheduling + auto-revert (BullMQ delayed jobs), empty states, error states, seed-store QA at 1,000 products. Also: the scheduled sweep that §5 defers — a periodic `resumeStalledJobs` across shops, so a job no longer waits on someone opening the app — and a claim around `reconcileBulkJob`.

**Phase 7 — Submission (day 14):** listing assets, privacy policy, review checklist pass, submit.

**Acceptance test (must pass before submission):** On a 1,000-product store: filter to a 300-product collection → decrease prices 15% + add tag "sale" in ONE job → preview shows correct diffs → apply completes < 5 min → undo restores all 300 exactly → job history shows both jobs.

---

## 10. Non-Goals (v1 — explicitly do not build)
- CSV/Excel import-export (Matrixify owns this; different product)
- AI-generated descriptions (v2 candidate — could route through PORDL later)
- Image editing, metafield editing (v1.1 — metafields are the #1 requested fast-follow, design schema to allow adding `fieldPath` values like `metafield.custom.material` later)
- Multi-store, translations, B2B catalogs/price lists
