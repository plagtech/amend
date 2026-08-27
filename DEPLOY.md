# Deploying Amend to Railway

The app is a single web service: Remix, Postgres, and an in-process timer. No
worker, no Redis, no cron service — see the header of
`app/lib/scheduler.server.ts` for why.

---

## 1. Two environments, two databases

**Dev and prod must not share a database.** They share a schema, and every
migration that runs against one would run against the other; a job row written
by a dev experiment would be swept, and possibly *applied*, by the production
scheduler against a real merchant's catalog.

| | Dev (today) | Prod |
|---|---|---|
| Postgres | Railway project `amend`, service `Postgres`, `railway` database | its own Postgres service, in a separate Railway **environment** |
| `DATABASE_URL` source | `.env` on the developer's machine | the service's Variables tab |
| Which URL | **public** TCP proxy (`…proxy.rlwy.net:PORT`) — the internal host does not resolve off Railway | **internal** (`${{ Postgres.DATABASE_URL }}`), which never leaves Railway's network |
| App registration | the dev app (`shopify app dev` rewrites its URLs on every run) | the production `client_id`, set once |
| Store | `amend-test-*.myshopify.com`, seeded with 1,000 products | real merchants |
| Charges | test charges (dev stores cannot be billed) | real |

Create prod as a **new Railway environment** rather than a second project: it
gets its own Postgres and its own variables while keeping one place to look.
`railway environment new production` (or the dashboard), then add a Postgres
plugin *inside that environment* — do not reference the dev one.

### The `.env` story

- **Dev:** `.env` on the developer's machine, gitignored, holding the public
  Postgres proxy URL and the seed store's Admin API token. `shopify app dev`
  injects `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` and `SHOPIFY_APP_URL` at
  runtime, which is why they are blank in the file and why
  `app/lib/apply.server.ts` imports `shopify.server` lazily — see the note
  there.
- **Prod:** no `.env` file at all. Everything comes from Railway's Variables
  tab, and `SHOPIFY_APP_URL` is the service's own domain. The seed variables
  (`SEED_*`) are **not** set in production: nothing in `app/` reads them, and a
  production service has no business holding a store's Admin token.

---

## 2. Variables the deployed service needs

```
SHOPIFY_API_KEY        = <production app's client_id>
SHOPIFY_API_SECRET     = <production app's client secret>
SCOPES                 = read_products,write_products
SHOPIFY_APP_URL        = https://<service>.up.railway.app   (no trailing slash)
DATABASE_URL           = ${{ Postgres.DATABASE_URL }}
NODE_ENV               = production
```

Optional, and deliberately unset in a normal production deploy:
`SCHEDULER_DISABLED`, `SCHEDULER_TICK_MS`, `BILLING_TEST`, `SHOP_CUSTOM_DOMAIN`.
See `.env.example` for what each one does.

`npm run docker-start` runs `prisma generate && prisma migrate deploy` before
starting the server, so a deploy applies pending migrations itself. Migrations
are additive; none of them drop a column.

---

## 3. Webhooks

Registered two ways, and both matter:

- **`shopify.app.toml`** declares them, and `shopify app deploy` registers them
  against whatever `application_url` the app registration holds. This is the
  path that matters for production.
- **`afterAuth`** in `app/shopify.server.ts` calls `registerWebhooks` on every
  install and re-auth, which covers a shop that installed before a topic was
  added.

Topics, and what breaks without each:

| Topic | Route | If it never arrives |
|---|---|---|
| `bulk_operations/finish` | `/webhooks/bulk_operations/finish` | large jobs still complete — the scheduler's sweep polls the operation — but minutes later rather than seconds |
| `app_subscriptions/update` | `/webhooks/app/subscriptions_update` | a cancellation is not noticed until someone opens Settings |
| `app/uninstalled` | `/webhooks/app/uninstalled` | the shop is never marked inactive |
| `app/scopes_update` | `/webhooks/app/scopes_update` | stored scope drifts from reality |
| `customers/data_request`, `customers/redact`, `shop/redact` | `/webhooks/customers/*`, `/webhooks/shop/redact` | **App Store review fails** — these are mandatory |

**API version pins stay as they are** (`2026-07`) and live in four places:
`app/shopify.server.ts`, `.graphqlrc.ts`, `shopify.app.toml` (`[webhooks]
api_version`), and `scripts/harness.ts`. A deploy is not the time to bump them.

> **`shopify app config link` rewrites `shopify.app.toml`.** It has previously
> dropped every `[[webhooks.subscriptions]]` block and the `handle`, silently.
> The file carries a warning comment; diff it before committing, every time.

---

## 4. Verifying a deploy without touching the live app

Everything below runs against a throwaway database and the local Docker daemon.
It never touches the production `client_id`, and it is what
`npm run verify:deploy` automates.

1. **Build the image the way Railway does** — `docker build` against the repo's
   `Dockerfile` (Railway is configured for `DOCKERFILE` in `railway.json`).
2. **Run migrations from zero** into a fresh database, proving the migration
   history applies to an empty schema and not just to the dev database that has
   been carried forward.
3. **Boot the container** with production-shaped variables.
4. **Check `/healthz`** — the path `railway.json` health-checks. It answers
   without touching Postgres on purpose, so a database blip does not cycle the
   container.
5. **Check the webhook endpoints respond** — an unsigned POST must be rejected
   (401), not 404 and not 500. A 404 means the route did not ship; a 500 means
   it shipped broken. Rejecting an unsigned request *is* the correct behaviour.

The one thing this cannot prove is OAuth, which needs a real app registration
and a real store. That is the cutover step, and it is deliberately not part of
this.

---

## 5. Verifying billing (needs one human click)

`npm run verify:billing` drives the subscription lifecycle against the dev store
with a **test charge** — dev stores cannot be billed for real. It is the one
check that cannot run unattended, for two reasons that are both correct
behaviour:

- **An app can only bill as itself.** Shopify refuses `appSubscriptionCreate`
  from a custom app's Admin API token: *"this application is currently owned by
  a Shop. It must be migrated to the Shopify partners area before it can create
  charges with the API."* So the seed token the other scripts use is useless
  here — this one runs as the app, using the offline token stored at install.
- **No API accepts a charge on the merchant's behalf.** The script prints the
  confirmation URL and waits for someone to approve it.

```
npm run dev                 # shopify app dev — installs and stores a fresh token
                            # (open the app in the dev store once)
npm run verify:billing      # then approve the charge at the URL it prints
```

The offline token **expires** (the template uses
`expiringOfflineAccessTokens`), so a stale one is normal after a few days. The
script detects it and says exactly this. Everything either side of the click is
automated: creating the subscription, `Shop.plan` following it to `pro`, the
gates opening, cancelling, and the gates closing again.

---

## 6. Cutover, when the app is ready to go live

In order:

1. Create the production environment and its Postgres.
2. Set the variables above, with `SHOPIFY_APP_URL` pointing at the Railway
   domain.
3. `shopify app deploy` against the production app registration, so
   `application_url`, the redirect URLs and the webhook subscriptions all point
   at that domain.
4. Install on a fresh dev store from the production registration and run one
   real edit and one undo.
5. Only then, submit for review.
