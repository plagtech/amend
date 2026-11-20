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

### Where the merchant lands after approving

`returnUrl` is the app's page **inside the Shopify admin**, built by
`billingReturnUrl()` in `app/lib/billing.server.ts`:

```
https://admin.shopify.com/store/<store>/apps/<client_id>/app/settings?upgraded=1
```

It is built from the shop and the app's client id — **never from a host**.
Shopify sends the merchant back top-level, outside the admin iframe, with only
`charge_id`; a URL on the app's own host (`${SHOPIFY_APP_URL}/app/...`, which is
what this used to be) arrives with no `shop`, `host` or session token, so
`authenticate.admin` bounces it to `/auth/login`. And `SHOPIFY_APP_URL` is a
tunnel that changes on every `shopify app dev`. The admin URL loads the app
embedded with a fresh session, and the settings loader re-syncs `Shop.plan`.
The admin rewrites `<client_id>` to the app's handle (`amend-3`) and keeps the
path.

**In production the return URL comes from the production app's client id** —
`SHOPIFY_API_KEY` in Railway's Variables. Nothing about it needs setting per
environment, and there is no app URL in it to get wrong. `verify:billing` uses
`SHOPIFY_API_KEY` when set and otherwise the `client_id` in
`shopify.app.toml`, the app the dev store installed.

### Test charges — where the flag lives

`isTest` is decided **at runtime, per request**, by `testChargesFor()` in
`app/lib/billing.server.ts` — not at build time. The billing page's loader
and action both call it. It is true when any of:

- the shop is a **development store** — `shop { plan { partnerDevelopment } }`,
  the check Shopify documents, read live on every billing-page request. This
  holds on the production deploy too: App Store reviewers install on
  development stores, and a development store can never become a paying one;
- `BILLING_TEST=1`;
- `NODE_ENV` is not `production`.

The Dockerfile sets `NODE_ENV=production`, so with `BILLING_TEST` unset a real
store gets a **real** charge and a development store gets a test charge.
`verify:plan` asserts the rule; `verify:billing` asserts the live dev store
reports `partnerDevelopment: true`.

---

## 6. Cutover — the exact order

Every step is done by hand, by the owner. Nothing here is automated, and
nothing in the repo runs it.

### 0. Split the registrations: cf910c16 is production only

**`cf910c1665cd705b068ebac7863b1966` becomes production and nothing else.**
Development moves to its own registration with its own toml, so `npm run dev`
can never touch production URLs. Two files, two apps:

| File | App | Used by |
|---|---|---|
| `shopify.app.toml` | cf910c16 (production) | `npm run deploy` → `shopify app deploy --config shopify.app.toml` |
| `shopify.app.dev.toml` | the dev registration | `npm run dev` → `shopify app dev --config dev` |

Both npm scripts pin `--config` on purpose. **The CLI makes whichever app you
linked most recently the default**, so after linking the dev app a bare
`shopify app deploy` would deploy the dev registration, and after re-linking
production a bare `shopify app dev` would tunnel production. Always use the
npm scripts, never the bare commands.

In order:

1. **Create the dev registration.**
   `shopify app config link --file-name shopify.app.dev.toml` → choose
   *create a new app* (name it `Amend Dev`), or pick one of the existing
   duplicate Amend registrations to reuse as dev.
2. ⚠ **The config-link gremlin bites here.** `config link` *writes the file
   from the remote app's settings*, and has previously dropped `handle` and
   every `[[webhooks.subscriptions]]` block. A brand-new dev app has none of
   ours. Open `shopify.app.dev.toml` next to `shopify.app.toml` and copy
   across: `embedded = true`, the `[build]` block with
   `automatically_update_urls_on_dev = true` (**dev only**),
   `[webhooks] api_version = "2026-07"` and all **seven** webhook blocks,
   `[access_scopes] scopes = "read_products,write_products"`. Do not add a
   `handle`. Keep the new file's own `client_id`, `name` and URLs.
3. **Check the CLI didn't touch production.** `git diff shopify.app.toml` must
   be empty. If `config link` rewrote it, `git checkout shopify.app.toml`.
4. **Turn off URL rewriting on production.** In `shopify.app.toml`, set
   `automatically_update_urls_on_dev = false`. Belt and braces: even a
   mistaken `shopify app dev --config shopify.app.toml` then cannot repoint
   the live app.
5. **Prove which app each script targets** before anything is deployed:
   `npx shopify app info --config dev` shows the dev client id;
   `npx shopify app info --config shopify.app.toml` shows `cf910c16…`. If the
   second form is not accepted by your CLI version, change the `deploy` script
   to the form it accepts *before* step 12.
6. `npm run dev`, install the dev app on `amend-test-awe1hzlv`, open it once.
   That stores the dev app's offline session (same database, same shop row),
   which `verify:billing` then uses — it reads the client id from
   `shopify.app.dev.toml`.
7. **Bulk mutations on the dev app** — see step 12a; the dev app needs it too,
   or every edit over 100 items fails in development.
8. **Only now delete the remaining duplicate registrations** (Dev Dashboard →
   app → Settings → delete), keeping cf910c16 and the dev app. Check each has
   no installs you care about first.

Decide whether `shopify.app.dev.toml` is committed. It holds no secrets (the
client id is not secret); committing it means a fresh clone can run
`npm run dev`.

### A. Railway

1. **The existing environment named `production` is the DEV database.** It
   holds the `Postgres` service that local `.env` reaches through
   `acela.proxy.rlwy.net`. Rename it `development` (Project → Settings →
   Environments) before creating the real one, so the name `production` can
   never point at dev data. If you do not rename it, give the new one a
   different name and use that everywhere below.
2. `railway environment new production` (or the dashboard). Inside **that**
   environment: New → Database → PostgreSQL. Do not reference or copy the dev
   Postgres.
3. Inside the same environment, add the app service from the repo. Railway
   picks up `railway.json` (Dockerfile builder, `npm run docker-start`,
   health check `/healthz`).
4. **Region**: service → Settings → Deploy → Region. Set the app **and** its
   Postgres to the same **US** region. The dev Postgres runs in `us-west2`;
   matching it is fine. Replicas: **1** (the scheduler assumes one instance).
5. Service → Settings → Networking → **Generate Domain**. This is
   `https://<service>.up.railway.app`, the production app URL. Write it down;
   every later step uses it.
6. Variables (service → Variables), all of §2:
   `SHOPIFY_API_KEY` = `cf910c1665cd705b068ebac7863b1966`,
   `SHOPIFY_API_SECRET` = its secret (Dev Dashboard),
   `SCOPES=read_products,write_products`,
   `SHOPIFY_APP_URL` = the step-5 domain, no trailing slash,
   `DATABASE_URL=${{ Postgres.DATABASE_URL }}`, `NODE_ENV=production`.
   Leave `BILLING_TEST`, `SCHEDULER_DISABLED`, `SCHEDULER_TICK_MS` and every
   `SEED_*` **unset**. Check the resolved `DATABASE_URL` host is
   `postgres.railway.internal`; if it shows `proxy.rlwy.net`, it is
   referencing the wrong database.
7. Deploy. In the deploy logs, confirm in order: `prisma migrate deploy`
   applying every migration from zero, then `[scheduler] started, every …ms`.
8. `curl -i https://<domain>/healthz` → `200`.
9. `curl -i -X POST https://<domain>/webhooks/shop/redact` → `400` (unsigned is
   refused; 404 means the route did not ship, 500 means it shipped broken).

### B. Shopify

10. In `shopify.app.toml`: `application_url = "https://<domain>"`,
    `redirect_urls = [ "https://<domain>/auth/callback" ]` (`authPathPrefix`
    is `/auth`), and `automatically_update_urls_on_dev = false` (step 0.4).
    Leave `api_version = "2026-07"`.
11. **Diff the toml** (`git diff shopify.app.toml`): seven webhook blocks
    present (`app/uninstalled`, `bulk_operations/finish`, `app/scopes_update`,
    `app_subscriptions/update`, and the three compliance topics), scopes
    unchanged, no `handle` line added.
12. `npm run deploy` (= `shopify app deploy --config shopify.app.toml`). It
    pushes the URLs and registers every webhook against `https://<domain>`. In
    the Dev Dashboard, open the new version and confirm the URLs and webhook
    endpoints show the Railway domain. Expect it to remove
    `include_config_on_deploy` from `shopify.app.toml` (config is always
    deployed now); commit that deletion, it is not a regression.

12a. **Enable bulk mutations** for cf910c16 (Shopify, Nov 6 2026: apps built
    by a Partner must opt in before running bulk operations, all API
    versions). Partner Dashboard → Apps → Amend → **API access requests** →
    *Run bulk operations* → **Allow bulk mutations**. (Shopify's API docs put
    the same switch at Dev Dashboard → app → Settings → Access requests →
    *Enable bulk mutations*; use whichever your account shows.) Granted
    immediately, no review, no redeploy.
    - **Mutations only.** Amend never calls `bulkOperationRunQuery` (snapshots
      are read with ordinary paginated queries), so bulk *queries* stay off.
    - **It lapses.** An app that starts no bulk mutation for **31 days** loses
      access and must be re-enabled. Any edit or undo over 100 items is a bulk
      mutation; a quiet month with only small edits is enough to lose it.
      Merchants are not broken by a lapse — large jobs finish inline, more
      slowly (see "If bulk access is missing" below) — but the Railway logs
      will show `[bulk] REFUSED`, and that is the signal to re-enable.
    - Do the same for the dev registration (step 0.7).

13. **IP allowlist — network (ASN) route, US only.** Do this only after the
    production service exists and has made Admin API calls (after step 12 and
    the first install in §7.1), so the test has real traffic to check against.
    1. Find the ASN Railway's egress uses: from the production service shell
       (`railway ssh`, production environment, app service),
       `curl -s https://ipinfo.io/org` → `AS<number> <name>`. Repeat after a
       redeploy; if a second ASN appears, list both.
    2. Dev Dashboard → cf910c16 → Settings → IP allowlist → Manage →
       **Networks (ASN)**: the ASN(s) from 1. **Limit ASNs to countries:**
       United States only. Leave IP addresses empty.
    3. **Test against recent traffic** → nothing from the last 30 days that
       came from Railway should be flagged. Fix and re-test until clean.
    4. Turn on **Enforce IP allowlist** → Save.
    5. From your own machine, one Admin API call with the app's token → must be
       `403`. (Development is unaffected: it runs as the dev registration,
       which has its own allowlist, if any.)

    Shopify's deadline for public apps is **Nov 20, 2026, 11:59 PM ET** —
    without an allowlist the app is delisted and blocked from new installs, and
    bulk operations from public apps without one are already being refused.
14. Run the smoke test (§7).
15. Only then, submit for review.

### If bulk access is missing — the job finishes inline

When Shopify will not **start** a bulk stage, the job does not fail: every
row not yet applied — in that stage and any after it — is written through the
inline path instead, with the same token bucket and per-row `applied`
tracking as a small job. This applies at any stage, and to undo jobs of any
size. (`continueInlineAfterRefusal` in `app/lib/apply.server.ts`.)

**What counts as a refusal to start** (`BulkStartRefused`,
`app/lib/bulk.server.ts`) — only outcomes where nothing can have started:

- staging the upload failed (the run mutation was never sent);
- Shopify answered `bulkOperationRunMutation` with a `userError`, or with a
  GraphQL error — access denied, throttled on every attempt, no data.

A **transport failure on the run call itself** is deliberately *not* a
refusal: the request may have reached Shopify and started an operation, so
falling back could write the stage twice. That call is never retried after a
transport failure, for the same reason: a retry's "already in progress" would
describe the first attempt, not a refusal. The job fails as before, and its
unapplied rows carry the reason so **Retry** can finish them.

**Accepted, then failed** is a separate case and unchanged: an operation
Shopify started and that ended `FAILED`/`CANCELED`/lost is reconciled first —
its partial results (`partialDataUrl`) marked applied — and only the remainder
goes inline (`fallBackToInline`).

**Nothing is applied twice.** Rows an earlier stage applied through Bulk
Operations are `applied: true` and are skipped. The refused stage never ran.
The job leaves bulk mode (`bulkOpGid` and `stage` cleared) *before* the inline
run starts, so the `bulk_operations/finish` webhook and any second reconcile
entrant find nothing to act on; the reconcile re-reads the job under its claim
for exactly this.

**Timing.** A later-stage refusal falls back immediately, in the reconcile
that hit it — it does not wait for the stale sweep. The heartbeat is stamped
at the hand-over and then every few seconds through the inline run, so the
sweep never takes a live job for a dead one and runs it twice. (Worst single
unit, with every retry and throttle wait: ~80 s; the sweep waits 3 min.)

**What you see vs. what the merchant sees.** The Railway log gets one line per
refusal:

```
[bulk] REFUSED: Shopify would not start the <stage> stage of job <id> for <shop>: <Shopify's message> — bulk mutation access may have lapsed (Partner Dashboard → API access requests). Finishing the job inline.
```

The merchant sees nothing alarming: no error on the job, which simply runs
inline — slower for a large edit, at the inline path's rate-limited pace
rather than Shopify's bulk pace.

**Failed jobs never strand rows.** Any job that fails with no bulk operation
in flight gives each unapplied row the job's reason, so Retry can find them.

**Verified** by `npm run verify:refusal`: three full runs against the seed
store, with Shopify's answer replaced by an access-denied refusal at the exact
point a real one arrives — the apply's first stage, the apply's second stage
after the first went through Bulk Operations, and a >100-item undo. Each
asserts the catalog byte-for-byte before, after apply and after undo; the
stage that was refused; that the job carries no error; that the refusal was
logged; and that the heartbeat never went stale.

---

## 7. Production smoke test (clicks, after §6)

On the dev store, against the production deploy:

1. **Install from the prod URL.** Open
   `https://<domain>/auth/login`, enter `amend-test-awe1hzlv.myshopify.com`,
   approve the install. Lands on the Amend dashboard inside the admin, with no
   tunnel anywhere in the iframe URL.
2. **Small edit.** New bulk edit → filter `tag:summer` → tick 3 products →
   action *Tags: add* `smoke-test` → Preview → three rows, before/after
   correct → Apply → job page shows completed, 3 items.
3. **Check Shopify.** Products → those three carry `smoke-test`.
4. **Undo.** Job page → Undo → confirm → the undo job completes; the tag is
   gone from all three in Shopify; dashboard history shows both jobs.
5. **Template.** From the finished job, Save as template → it appears on
   Templates → Use → the wizard opens pre-filled.
6. **Bulk job (>100 items) + undo.** This is the path that needs bulk
   mutations enabled (§6 step 12a) and the IP allowlist (step 13), and the
   only one that exercises the `bulk_operations/finish` webhook on the prod
   URL. New bulk edit → collection **Summer Sale** (296 products) → variant
   view, select all matching → action *Tags: add* `smoke-bulk` → Preview →
   Apply. Expect: the job page shows *running* through Shopify's bulk
   operation, then completed with every row applied, within a few minutes.
   Railway logs show `Received BULK_OPERATIONS_FINISH webhook`. Spot-check two
   products in Shopify. Then **Undo** → that is a second bulk job → completes
   → `smoke-bulk` is gone from the spot-checked products. A job that **fails
   at once with an access-denied message** means step 12a was missed; one that
   fails with a `403` means the allowlist is missing Railway's network.
7. **Billing page.** Settings loads, shows Free, the job meter and the Pro
   card. Clicking Upgrade on this dev store now creates a **test** charge
   (`partnerDevelopment`, §5) — approve it, land back on Settings inside the
   admin showing Pro, then cancel.
8. Railway logs during all of the above: no 5xx, no `403` from Shopify. The
   3-item edit in step 2 is inline, so it produces no `bulk_operations/finish`
   delivery; the step-6 job and its undo produce one each per stage.

Undo the smoke jobs before using the store for screenshots, so the seed
catalog stays the `verify:filters` fixture.
