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

Remaining phases (Edit → Preview → Apply → Undo, billing) are tracked in
`Spec.md` §9.

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
`Snapshot`, and `SavedTemplate` per `Spec.md` §4. The initial Postgres
migration is `prisma/migrations/0_init`.

## Webhooks

| Topic | Route | Behavior |
|---|---|---|
| `app/uninstalled` | `webhooks.app.uninstalled.tsx` | Delete sessions, mark shop inactive |
| `app/scopes_update` | `webhooks.app.scopes_update.tsx` | Update stored scope |
| `customers/data_request` | `webhooks.customers.data_request.tsx` | 200 (no customer data stored) |
| `customers/redact` | `webhooks.customers.redact.tsx` | 200 (no customer data stored) |
| `shop/redact` | `webhooks.shop.redact.tsx` | Delete all shop data |
