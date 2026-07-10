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
model. Remaining phases (Select → Edit → Preview → Apply → Undo, billing) are
tracked in `Spec.md` §9.

## Tech stack

- **Framework:** Shopify Remix app template (TypeScript)
- **UI:** Polaris web components + App Bridge
- **DB:** Postgres via Prisma (`prisma/schema.prisma`)
- **Admin API:** GraphQL Admin API `2025-07`
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
