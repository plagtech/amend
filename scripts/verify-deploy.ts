/**
 * Proves the deploy works before it is pointed at anything real.
 *
 *   npm run verify:deploy
 *
 * Builds the image Railway would build, runs migrations into a database that
 * starts empty, boots the container with production-shaped variables, and asks
 * it the questions Railway and Shopify will ask: does `/healthz` answer, did
 * the migrations apply, are the webhook endpoints there, did the scheduler
 * start.
 *
 * It touches no app registration and no live `client_id`. OAuth is the one
 * thing it cannot cover — that needs a real app and a real store, and it is the
 * cutover step, not this one (see DEPLOY.md).
 *
 * Isolation: migrations run into their own Postgres *schema* on the dev server
 * — `search_path` is the only thing shared, and the schema is dropped at the
 * end. The dev tables are never opened.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import process from "node:process";

import { assertTrue, check, loadEnvFile, report, sleep } from "./harness";

const IMAGE = "amend-deploy-smoke";
const CONTAINER = "amend-deploy-smoke";
const PORT = 3999;

/** Long enough for `prisma migrate deploy` plus a Remix boot on a cold image. */
const BOOT_TIMEOUT_MS = 180_000;

/** Every webhook the app declares, and the path it must answer on. */
const WEBHOOK_PATHS = [
  "/webhooks/app/uninstalled",
  "/webhooks/app/scopes_update",
  "/webhooks/app/subscriptions_update",
  "/webhooks/bulk_operations/finish",
  "/webhooks/customers/data_request",
  "/webhooks/customers/redact",
  "/webhooks/shop/redact",
];

function docker(args: string[], options: { quiet?: boolean } = {}): string {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0 && !options.quiet) {
    throw new Error(
      `docker ${args.slice(0, 2).join(" ")} failed:\n${result.stderr || result.stdout}`,
    );
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

/** A URL onto the dev Postgres server, in a schema of this run's own. */
function smokeDatabaseUrl(schema: string): string {
  const base = process.env.DATABASE_URL;
  if (!base) {
    console.error("Set DATABASE_URL in .env — the smoke test needs a Postgres server.");
    process.exit(1);
  }
  const url = new URL(base);
  url.searchParams.set("schema", schema);
  return url.toString();
}

async function main(): Promise<void> {
  loadEnvFile();

  const schema = `amend_smoke_${Date.now()}`;
  const databaseUrl = smokeDatabaseUrl(schema);
  const migrations = readdirSync("prisma/migrations", { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  let started = false;

  try {
    // --- the daemon --------------------------------------------------------
    const version = docker(["version", "--format", "{{.Server.Version}}"], {
      quiet: true,
    }).trim();
    if (!version) {
      console.error(
        "Docker is not running. Start Docker Desktop and re-run — this check builds the real image.",
      );
      process.exit(1);
    }
    console.log(`Docker ${version}\n`);

    // --- build -------------------------------------------------------------
    console.log("Build — the image Railway builds, from the repo's Dockerfile:");
    const build = spawnSync("docker", ["build", "-t", IMAGE, "."], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 128 * 1024 * 1024,
    });
    if (build.status !== 0) {
      console.log(build.stdout?.slice(-4000) ?? "");
      console.log(build.stderr?.slice(-4000) ?? "");
    }
    check("the image builds", build.status, 0);
    if (build.status !== 0) return;

    // --- boot --------------------------------------------------------------
    console.log("\nBoot — production variables, an empty database:");
    docker(["rm", "-f", CONTAINER], { quiet: true });
    docker([
      "run",
      "-d",
      "--name",
      CONTAINER,
      "-p",
      `${PORT}:3000`,
      "-e",
      `DATABASE_URL=${databaseUrl}`,
      "-e",
      "NODE_ENV=production",
      "-e",
      "SHOPIFY_API_KEY=smoke-test-key",
      "-e",
      "SHOPIFY_API_SECRET=smoke-test-secret",
      "-e",
      "SCOPES=read_products,write_products",
      "-e",
      `SHOPIFY_APP_URL=http://localhost:${PORT}`,
      IMAGE,
    ]);
    started = true;

    const booted = await waitForHealth();
    if (!booted) {
      console.log(docker(["logs", "--tail", "80", CONTAINER], { quiet: true }));
    }
    assertTrue("the container answers /healthz", booted);
    if (!booted) return;

    const health = await fetch(`http://localhost:${PORT}/healthz`);
    check("healthz status", health.status, 200);
    check("healthz body", (await health.text()).trim(), "ok");

    // --- migrations --------------------------------------------------------
    console.log("\nMigrations — applied by the container, into an empty schema:");
    const logs = docker(["logs", CONTAINER], { quiet: true });
    assertTrue(
      "the start command ran prisma migrate deploy",
      logs.includes("migrations") || logs.includes("migrate"),
    );

    const applied = await appliedMigrations(databaseUrl);
    check(
      "every migration in the repo is recorded as applied",
      applied.sort(),
      migrations.sort(),
    );

    // --- the scheduler -----------------------------------------------------
    console.log("\nScheduler — the background trigger comes up with the server:");
    assertTrue(
      "it started, and said so",
      docker(["logs", CONTAINER], { quiet: true }).includes("[scheduler] started"),
    );

    // --- webhooks ----------------------------------------------------------
    console.log("\nWebhooks — every declared endpoint is present and refuses to be spoofed:");
    for (const path of WEBHOOK_PATHS) {
      // Two ways of being wrong, and the difference matters. An unsigned
      // request is missing its headers entirely, which the library answers
      // 400; a request carrying a *wrong* signature gets as far as HMAC
      // verification and is answered 401. Both are the route working. A 404
      // would mean it never shipped, and a 500 that it shipped broken.
      const unsigned = await fetch(`http://localhost:${PORT}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ smoke: true }),
      });
      check(
        `POST ${path} — unsigned is refused (${unsigned.status})`,
        unsigned.status === 400 || unsigned.status === 401,
        true,
      );

      const forged = await fetch(`http://localhost:${PORT}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Topic": "app/uninstalled",
          "X-Shopify-Hmac-Sha256": "not-a-real-signature",
          "X-Shopify-Shop-Domain": "amend-smoke.myshopify.com",
          "X-Shopify-API-Version": "2026-07",
          "X-Shopify-Webhook-Id": "smoke",
        },
        body: JSON.stringify({ smoke: true }),
      });
      check(`POST ${path} — a forged signature is rejected`, forged.status, 401);
    }
  } finally {
    if (started) {
      docker(["rm", "-f", CONTAINER], { quiet: true });
    }
    dropSchema(schema);
  }

  report();
}

async function waitForHealth(): Promise<boolean> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let announced = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://localhost:${PORT}/healthz`);
      if (response.ok) return true;
    } catch {
      if (!announced) {
        console.log("      … waiting for migrations and boot");
        announced = true;
      }
    }
    await sleep(2000);
  }
  return false;
}

/**
 * What `_prisma_migrations` in the smoke schema says was applied.
 *
 * Read with the Prisma CLI rather than a driver, so this needs no dependency
 * the app does not already have.
 */
async function appliedMigrations(databaseUrl: string): Promise<string[]> {
  const output = execFileSync(
    "npx",
    ["prisma", "migrate", "status", "--schema", "prisma/schema.prisma"],
    {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: databaseUrl },
      shell: process.platform === "win32",
    },
  );
  // "Database schema is up to date!" means every migration in the folder is
  // recorded; anything else lists what is missing, and we report that verbatim.
  if (!/up to date/i.test(output)) {
    console.log(output.trim());
    return [];
  }
  return readdirSync("prisma/migrations", { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function dropSchema(schema: string): void {
  const result = spawnSync(
    "npx",
    ["prisma", "db", "execute", "--url", process.env.DATABASE_URL ?? "", "--stdin"],
    {
      input: `DROP SCHEMA IF EXISTS "${schema}" CASCADE;`,
      encoding: "utf8",
      shell: process.platform === "win32",
    },
  );
  if (result.status !== 0) {
    console.error(
      `\nCould not drop the smoke schema "${schema}" — drop it by hand.\n${result.stderr}`,
    );
  }
}

main().catch((error) => {
  console.error(`\nVerification failed: ${(error as Error).message}`);
  spawnSync("docker", ["rm", "-f", CONTAINER]);
  process.exit(1);
});
