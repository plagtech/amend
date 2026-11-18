# Amend — App Store listing (draft)

Everything a reviewer or merchant reads, in one place, written against what the
app actually does today. **`⟪NEEDS YOU⟫` marks a value only the owner can
supply** — nothing here has been invented to fill one.

Rules this draft is written to (App Store requirements §4, checked on
shopify.dev 2026-11-17):

- **Pricing appears only in Pricing details.** Not in the description, the
  feature list, screenshots, the video, or the icon (4.2.2, 4.2.3). That is why
  the price appears only in the Pricing section below.
- No "the best / the first / the only", no statistics in the subtitle or
  introduction, no reviews or testimonials anywhere (4.3, 4.4.1).
- The listing name must stay similar to the Dev Dashboard name (`Amend`) — it
  is (4.1.1).
- Screenshots 1600×900, 3–6 of them, each a different view, no browser chrome,
  no pricing, alt text on each.
- Up to five search terms, whole words, one idea each.

Field limits not listed above (name, subtitle, details) are enforced by the
submission form's own counters — check them there; the lengths below are
noted so you can see the margin.

---

## Identity

| Field | Value |
|---|---|
| App name | **Amend ‑ Bulk Product Editor** (27 chars) |
| App card subtitle | **Bulk edit products safely: preview every change, undo any edit** (62 chars) |
| App introduction (≤100) | **Change prices, tags and text across your whole catalog, see every change first, and undo any edit.** (98) |
| Title tag | **Amend ‑ Bulk Product Editor with Preview and Undo** (49) |
| Meta description | **Bulk edit product prices, tags, titles, SEO, SKUs and more in one job. Preview every change exactly before it runs, and undo any edit on any plan.** (~146) |
| Search terms (5) | `bulk edit` · `bulk product editor` · `price editor` · `product tags` · `undo` |
| Developer name | Plagtech ⟪NEEDS YOU: confirm the exact public developer name⟫ |
| Support email | ⟪NEEDS YOU⟫ |
| Privacy policy URL | ⟪NEEDS YOU — on a domain you own, not `*.up.railway.app` (SPEC §8)⟫ |
| Emergency developer contact | ⟪NEEDS YOU⟫ |
| Demo store URL | optional — the seeded dev store is not public; leave blank unless you set up a password-free demo |

**Category (recommended):** Store management → Operations, with the
bulk-editing tag if the picker offers one; secondary, Selling products →
product management. Confirm against the category definitions in the
submission form — the taxonomy is the form's, not ours, and a wrong primary
category is a review rejection (4.3.5).

---

## App details (description)

> **Every edit previewed exactly before it runs, every edit undoable on any plan.**
>
> Amend changes many products at once — prices, compare-at prices, cost,
> tags, status, titles, descriptions, vendor, product type, SEO title and
> description, SKU, barcode, weight, and inventory settings — and lets you
> stack several of those changes into one job. Filter your catalog by
> collection, vendor, type, tag, status, price, SKU, inventory or date, work
> at product or variant level, and select everything that matches, not just
> the page you can see.
>
> Before anything is written, Amend shows you the exact before and after
> value for every row. Untick any row you want left alone. Nothing changes
> until you press Apply.
>
> Every job saves the values it is about to replace before it writes a
> single one, so any edit can be reversed with one click — on every plan,
> including after a downgrade. If a product was changed somewhere else since
> your edit, undo still restores it and tells you which rows had moved.
>
> Save the edits you repeat as templates, and schedule an edit for later with
> an automatic revert — a weekend sale that ends itself.

Accuracy notes on that copy — check before submitting:

- **"Previewed exactly"** is literally true for an edit applied from the
  preview: the job persists the reviewed rows. A **scheduled** edit is
  previewed at scheduling time but resolves against the catalog as it is
  when it fires (SPEC §9), so its rows can differ from what was previewed.
  If you want the lead line airtight, say "Every edit previewed before it
  runs" — or keep it and the details paragraph on scheduling stays honest.
- **Undo window.** Undo data is kept 90 days on Free and 365 on Pro, then
  deleted by the retention sweep (`retention.server.ts`, `verify:retention`).
  Past the window the app says *undo expired*. "Undoable on any plan" is
  true within that window; the Pricing section states the windows.
- Inventory **quantity** is not editable, by design (SPEC §3). The copy says
  "inventory settings" for that reason; do not change it to "inventory".

## Feature list

- Stack price, tag, status, text, SEO, SKU, barcode and weight changes in one job
- Exact before → after preview of every row, with per-row exclude
- One-click undo for every edit, on every plan
- Find and replace in titles, descriptions and tags, with regex for advanced edits
- Variant-level selection, and select-all across the whole filter
- Scheduled edits with automatic revert for sale windows
- Saved templates for the edits you repeat
- Large catalogs handled by Shopify's Bulk Operations

## Pricing details (the only place prices appear)

**Free** — $0
- Unlimited products per edit — no catalog-size cap
- 10 edit jobs per month
- Undo on every edit (90-day undo history)
- 3 saved templates

**Pro** — $19 USD / 30 days, **7-day free trial**
- Unlimited edit jobs
- Unlimited saved templates
- Regex find & replace
- Scheduled edits and automatic revert
- 365-day undo history
- Priority support

Billed through Shopify. Cancel any time from Settings; templates past the free
allowance become read-only, nothing is deleted, and undo keeps working.

(Matches `PRO_PRICE`, `PRO_TRIAL_DAYS` in `app/lib/billing.server.ts` and the
gates in SPEC §7. Advanced/$49 is v1.1 — do not list it.)

---

## Data and privacy answers

| Question | Answer |
|---|---|
| Access scopes | `read_products`, `write_products` only |
| Customer data | **None** read, stored or processed. No customer, order or checkout scopes. |
| Staff/personal data | None. The app uses offline tokens only, so no staff name or email is stored. |
| What is stored | Shop domain and its offline access token; plan and monthly job count; each edit job (its filter and actions); before/after **snapshots of product field values** the job touched (prices, tags, titles, descriptions, SEO, SKU, barcode, weight, inventory settings); saved templates. |
| Why | Snapshots are the undo. Without them an edit cannot be reversed. |
| Where | Postgres on Railway, US region ⟪NEEDS YOU: confirm the prod region in §6 step 4 of DEPLOY.md⟫. Sub-processor: Railway. |
| Retention | Snapshots: **90 days** after the edit on Free, **365** on Pro, then deleted automatically (hourly sweep); the job's summary row stays in history. Everything else: until uninstall + `shop/redact`. |
| Uninstall | `app/uninstalled` deletes the shop's sessions and marks the shop inactive. |
| Deletion | `shop/redact` (sent by Shopify 48 h after uninstall) deletes every job, snapshot, template, session and the shop row, in one transaction. |
| GDPR webhooks | `customers/data_request`, `customers/redact`, `shop/redact` declared in `shopify.app.toml`, HMAC-verified (unsigned and forged requests rejected — `verify:deploy`). The customer topics acknowledge with 200: there is no customer data to return or erase. |

---

## Icon

**1200 × 1200 px**, uploaded in the Dev Dashboard (app → Settings). No
pricing, no Shopify logo or trademarks, legible at small sizes. ⟪NEEDS YOU⟫

---

## Screenshots (1600 × 900, against **prod**, 6 shots)

Capture inside the admin with the browser at a window size that yields 16:9,
then crop to the app frame — no browser chrome, no desktop. Avoid the
Settings page (it shows the price). Use the seeded dev store so no real
merchant data appears.

| # | Screen | State to set up first | Alt text |
|---|---|---|---|
| 1 | **Preview diff** (lead shot) | Summer Sale collection, price −15% round to .99 + add tag `sale`. Preview open, struck-through before → after values, summary banner, one row unticked. | Preview table showing each product's old and new price and tags before applying |
| 2 | **Select** | New bulk edit, filter collection *Summer Sale* + price range, variant view on, "select all matching" ticked so the banner shows the full count. | Product filter with every matching variant selected |
| 3 | **Stacked actions** | Same job, actions panel with three actions: price, tags, status. | Several edits stacked into one bulk job |
| 4 | **Job complete + Undo** | Apply the shot-1 job; job page at completed with item count and the Undo button visible. | Finished edit with a one-click Undo button |
| 5 | **Dashboard history** | Several jobs in history, one marked undone, its undo job beside it; usage meter visible. | Edit history with completed and undone jobs |
| 6 | **Schedule a sale window** | Confirm step with a start time and an auto-revert time set. Pro-only — see the note below. | Scheduling an edit with an automatic revert |

Alternative for 6 if scheduling cannot be shown: **Find & replace in
descriptions** — a text action with a find/replace pair and its preview rows.

Shot 6 needs Pro. On the dev store that is now a test charge even against
prod (DEPLOY.md §5): upgrade, capture, cancel.

Undo the shot-1 job after capturing, so the seed catalog stays the
`verify:filters` fixture.

---

## Feature video (2–3 min, promotional)

Shopify's guidance: promotional rather than instructional, screencast at most
about a quarter of the runtime, English or English subtitles, no pricing.

| t | Shot |
|---|---|
| 0:00–0:15 | The problem: a merchant about to change hundreds of prices, and the fear of getting it wrong. Title card: *Every edit previewed. Every edit undoable.* |
| 0:15–0:40 | Screencast: filter to a collection, select all matching. |
| 0:40–1:05 | Screencast: stack price −15% + tag `sale` + status; open the preview; scroll the before → after diffs; untick one row. |
| 1:05–1:20 | Apply; progress; done. |
| 1:20–1:40 | The point of the app: a mistake noticed → one click Undo → every value back. |
| 1:40–2:00 | Sale window: schedule start and automatic revert. |
| 2:00–2:20 | Templates, regex find & replace, variant-level edits — quick cuts. |
| 2:20–2:30 | End card: app name and subtitle. No price. |

Keep the screencast segments short and cut between them with motion/text cards
so the whole runs promotional.

## Review screencast (separate, for the reviewer)

Unlike the feature video this one is instructional and complete: install from
the prod URL → empty dashboard → one edit through preview and apply → verify
in Shopify Products → undo → verify again → save a template → Settings with
the plan shown → uninstall. Narrate or caption in English.

---

## Submission checklist

### Done and verified in the repo (2026-11-17)

- [x] All gates green on the current tree against live Shopify 2026-07:
      `tsc`, `build`, `verify:filters`, `verify:plan`, `verify:apply`,
      `verify:apply -- --bulk`, `verify:schedule`, `verify:deploy`.
- [x] GDPR + uninstall handlers present, HMAC-verified, declared in
      `shopify.app.toml` (`verify:deploy`).
- [x] Minimal scopes: `read_products,write_products`.
- [x] API version 2026-07: supported until July 2027; no deprecated field in
      any shipped document (Shopify rejects submissions using APIs deprecated
      within 90 days).
- [x] Billing return URL lands on the embedded app, built from the client id,
      no host (`billingReturnUrl`, DEPLOY.md §5).
- [x] Test charges: runtime, per request — real charges on real stores in
      prod, test charges on development stores (`partnerDevelopment`), so
      reviewers can click Upgrade (DEPLOY.md §5, `verify:plan`).
- [x] Undo retention enforced: 90/365 days, expired undo shown as expired
      (`verify:retention`).
- [x] `package.json`: `"name": "amend"`, `"author": "Plagtech"`.
- [x] Bulk access refused or lapsed: large edits and undos finish inline
      instead of failing (`verify:refusal`, DEPLOY.md §6).

### Needs you

- [ ] **IP allowlist**, ASN route, US only, after the prod service exists
      (DEPLOY.md §6 step 13). Shopify's deadline for public apps
      is **Nov 20, 2026**; bulk operations from public apps without one have
      been blocked since Nov 12.
- [ ] Split registrations: dev app + `shopify.app.dev.toml`, cf910c16
      production only, then delete the other duplicates (DEPLOY.md §6 step 0).
- [ ] **Enable bulk mutations** for cf910c16 and the dev app; re-enable after
      31 idle days (DEPLOY.md §6 step 12a).
- [ ] Railway prod environment, Postgres, domain, variables, region US
      (DEPLOY.md §6 A).
- [ ] App URL + redirect URL on the prod domain, `shopify app deploy`,
      webhooks confirmed against the prod URL in the Dev Dashboard (§6 B).
- [ ] Prod smoke test (DEPLOY.md §7).
- [ ] Privacy policy on a domain you own; support email; emergency contact.
- [ ] Landing page copy: `app/routes/_index/route.tsx` still reads
      "A short heading about [your app]" — reviewers can reach it.
- [ ] 1200 × 1200 icon; six screenshots; feature video; review screencast.
- [ ] Confirm the app name is unique in the App Store search.
- [ ] Listing pricing entered exactly as above, trial included.
