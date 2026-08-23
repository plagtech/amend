# Amend — Bulk Product Editor

> The bulk editor that never breaks your catalog.

An embedded Shopify admin app to filter products/variants, preview exact
before → after changes, apply bulk edits, and undo any edit with one click.

Built on the [Shopify Remix app template](https://github.com/Shopify/shopify-app-template-remix)
(Remix + Polaris + App Bridge), Prisma + Postgres, deployed on Railway.

See [`Spec.md`](./Spec.md) for the full product/build specification.

## Status

**Phase 1 (Scaffold) — complete.** The app scaffolds, builds, and type-checks.
GDPR + uninstall webhooks are wired. Prisma is on Postgres with the full data
model.

**Phase 2 (Select) — complete.** `/app/edit/new` filters the catalog by
collection, vendor, product type, tag, status, price, inventory, SKU, and free
text; toggles between product and variant rows; pages with cursors; and
supports "select all matching filter" across pages. A seed script builds a
realistic 1,000-product test catalog.

**Phase 3 (Edit + Preview) — complete.** Stackable edit actions (price, tags,
status) with server-computed before → after diffs, a per-row exclude checkbox,
and a summary of exactly what will change. Nothing writes until Apply.

**Phase 4 (Apply + Undo) — complete.** Jobs snapshot every value they are about
to overwrite *before* the first mutation runs, then apply — inline for small
edits, via Bulk Operations above 100 line-items — and undo restores the
snapshot as a job of its own. One job runs per shop at a time; the rest queue.
Jobs are resumable, so a crashed worker picks up where it stopped without
double-applying. See [The job engine](#the-job-engine).

Remaining phases (the rest of the edit actions, templates, billing) are tracked
in `Spec.md` §9.

## Tech stack

- **Framework:** Shopify Remix app template (TypeScript)
- **UI:** Polaris web components + App Bridge
- **DB:** Postgres via Prisma (`prisma/schema.prisma`)
- **Admin API:** GraphQL Admin API `2026-07`
- **Scopes:** `read_products`, `write_products` (minimal)
- **Hosting:** Railway (Dockerfile + `railway.json`)

## Prerequisites

1. **Node.js** ≥ 20.19 (or ≥ 22.12).
2. **Shopify Partner account** + a development store.
3. **Shopify CLI:** `npm install -g @shopify/cli@latest`.
4. **Postgres** — a local instance for dev, or a Railway Postgres plugin.

## Local development

```shell
# 1. Install deps
npm install

# 2. Configure environment
cp .env.example .env        # then fill in values (see below)

# 3. Link to a Partner-dashboard app (fills client_id + URLs in shopify.app.toml)
npm run config:link

# 4. Apply the database schema to your Postgres
npm run prisma migrate deploy   # or: npx prisma migrate dev

# 5. Run (Shopify CLI provides a tunnel + injects SHOPIFY_API_KEY/SECRET/APP_URL)
npm run dev
```

`shopify app dev` opens the app in your dev store to verify the embedded app
loads.

### Required environment variables

See [`.env.example`](./.env.example). `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`,
and `SHOPIFY_APP_URL` are injected by the Shopify CLI during `npm run dev`; you
must supply `DATABASE_URL` (Postgres) yourself.

## Seeding a test catalog

`scripts/seed-products.ts` fills a **development store** with 1,000 products /
3,000 variants spread across 8 collections, 8 vendors, 10 product types, 12
tags, three statuses, and a $5–$480 price range — enough for every filter to
have something to bite on. `Summer Sale` lands at ~301 products, which is the
collection the `Spec.md` §9 acceptance test runs against.

Mint a token in the dev store (Settings → Apps and sales channels → Develop
apps → create an app with `read_products` + `write_products` → install → copy
the Admin API access token), then add to `.env`:

```shell
SEED_SHOP_DOMAIN=your-store.myshopify.com
SEED_ADMIN_TOKEN=shpat_xxxxxxxx
```

```shell
npm run seed -- --dry-run     # generate offline, print the distribution
npm run seed                  # create 1,000 products (~10-15 min, rate-limited)
npm run seed -- --count 50    # a smaller catalog
npm run seed -- --destroy     # remove everything the script created
```

The catalog is generated from a fixed PRNG seed, so repeated runs produce the
same products. Everything it creates is tagged `amend-seed`, and `--destroy`
matches on that tag — it will never delete products it didn't make.

## The job engine

`app/lib/apply.server.ts` is the whole of APPLY and UNDO. The rule it exists to
enforce, and the one every design decision in it serves:

> **No mutation runs until 100% of the job's snapshots are persisted.**

That is structural, not a convention. The snapshot write and the
`snapshotting → running` transition are one database transaction, and the
mutation phase refuses to send anything for a job that is not `running` with a
snapshot count matching `totalItems`. There is no state in which the catalog
has changed and the before-picture is incomplete.

| Concern | Where | Note |
|---|---|---|
| Before-values | `snapshots.server.ts` | APPLY re-resolves the selection server-side through `buildPreview`, so the diff a merchant approved and the values written are produced by the same code. UNDO reads the *live* value, which is how drift gets flagged. |
| Mutation building | `mutations.ts` | Pure. The inline and bulk paths send byte-identical variables and differ only in delivery. |
| Small jobs (≤100 rows) | `runInline` | Batched mutations, 10 variants per call, cost-aware rate limiting in `throttle.server.ts`. |
| Large jobs | `bulk.server.ts` | Staged JSONL upload → `bulkOperationRunMutation`, one stage per mutation type. Results are matched back to rows by `__lineNumber`. |
| Completion | `webhooks.bulk_operations.finish.tsx` | No polling. A missed delivery is caught by the stale sweep, which reconciles by reading the operation. |
| Resume | `Snapshot.applied` + `EditJob.heartbeatAt` | Per-row state, so a resume never re-applies what already landed. |
| Concurrency | `claimRunSlot` | A serializable transaction. Two Apply clicks cannot both start. |

Undo is free on every plan and never consumes a job credit — SPEC §7.

## Verification

Two scripts check the app against a real seeded store rather than against
mocks. Both need `SEED_SHOP_DOMAIN` and `SEED_ADMIN_TOKEN`; `verify:apply`
also needs `DATABASE_URL`.

```bash
npm run verify:filters          # filter counts + diff arithmetic vs the seed's PRNG
npm run verify:apply            # a real edit + undo, inline path (~6 products)
npm run verify:apply -- --bulk  # the same, through Bulk Operations (~100 products)
```

`verify:apply` drives the real engine — the same `createApplyJob` / `runJob` /
`createUndoJob` the routes call — and reads the store back from Shopify before
the edit, after the edit, and after the undo. It asserts the catalog ends up
byte-for-byte where it started, that per-row exclusions and unselected products
were left alone, and that a job with an incomplete snapshot refuses to write at
all. It writes to the store and reverses itself, so point it at a dev store
only; the job rows it creates are cleaned up on the way out.

## Deploying to Railway

1. Create a Railway project and add a **Postgres** plugin.
2. Add a service from this repo — Railway builds the `Dockerfile` (see
   `railway.json`). The container runs `prisma migrate deploy` then starts the
   server (`npm run docker-start`).
3. Set service variables: `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`,
   `SCOPES=read_products,write_products`, `SHOPIFY_APP_URL` (the Railway public
   domain), and `DATABASE_URL=${{ Postgres.DATABASE_URL }}`.
4. Set `application_url` + `[auth].redirect_urls` in `shopify.app.toml` to the
   Railway domain, then `npm run deploy` to push app config to Shopify.
5. Health check is served at `/healthz`.

## Data model

`prisma/schema.prisma` defines `Session` (Shopify), `Shop`, `EditJob`,
`Snapshot`, and `SavedTemplate` per `Spec.md` §4, plus the columns the job
engine needs on the last two (delivery mode, bulk stage, heartbeat, per-row
applied/error/drift). Migrations: `prisma/migrations/`.

## Webhooks

| Topic | Route | Behavior |
|---|---|---|
| `app/uninstalled` | `webhooks.app.uninstalled.tsx` | Delete sessions, mark shop inactive |
| `app/scopes_update` | `webhooks.app.scopes_update.tsx` | Update stored scope |
| `bulk_operations/finish` | `webhooks.bulk_operations.finish.tsx` | Settle a job's bulk stage and start the next |
| `customers/data_request` | `webhooks.customers.data_request.tsx` | 200 (no customer data stored) |
| `customers/redact` | `webhooks.customers.redact.tsx` | 200 (no customer data stored) |
| `shop/redact` | `webhooks.shop.redact.tsx` | Delete all shop data |
