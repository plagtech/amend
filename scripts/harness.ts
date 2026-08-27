/**
 * The bits every verification script needs: a pass/fail counter, `.env`
 * loading, and an `AdminApiContext` backed by nothing but an API token.
 *
 * That last one is the important one. The engine takes its admin client as an
 * argument precisely so a script can drive the real code with a token and no
 * app installation, session, or tunnel — see `apply.server.ts`. Everything here
 * is test scaffolding; nothing in `app/` imports it.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

/** Keep in step with `ApiVersion.July26` in `app/shopify.server.ts`. */
export const API_VERSION = "2026-07";

let failures = 0;

export function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    ok
      ? `PASS  ${label}`
      : `FAIL  ${label}` +
          `\n        got      ${truncate(actual)}` +
          `\n        expected ${truncate(expected)}`,
  );
}

export function assertTrue(label: string, condition: boolean): void {
  check(label, condition, true);
}

/** For the many checks of the form "this threw, and said the right thing". */
export async function expectError(
  label: string,
  fn: () => Promise<unknown>,
  matches: (message: string) => boolean,
): Promise<void> {
  try {
    await fn();
    check(label, "no error", "an error");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (matches(message)) {
      console.log(`PASS  ${label}`);
    } else {
      failures += 1;
      console.log(`FAIL  ${label}\n        message was: ${message}`);
    }
  }
}

export function failureCount(): number {
  return failures;
}

export function report(): never {
  console.log(
    failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

function truncate(value: unknown): string {
  const text = JSON.stringify(value);
  return text && text.length > 400 ? `${text.slice(0, 400)}…` : String(text);
}

export function loadEnvFile(): void {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;
      const [, key, value] = match;
      if (process.env[key] === undefined) {
        process.env[key] = value.replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // No .env — rely on the ambient environment.
  }
}

/** An `AdminApiContext` backed by an Admin API access token. */
export function stubAdmin(shop: string, token: string): AdminApiContext {
  return {
    graphql: async (query: string, options?: { variables?: unknown }) =>
      fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({ query, variables: options?.variables ?? {} }),
      }),
  } as unknown as AdminApiContext;
}

/** The seed store's credentials, or a clear explanation of what is missing. */
export function requireSeedEnv(): { shop: string; token: string } {
  loadEnvFile();
  const shop = process.env.SEED_SHOP_DOMAIN;
  const token = process.env.SEED_ADMIN_TOKEN;
  if (!shop || !token) {
    console.error("Set SEED_SHOP_DOMAIN and SEED_ADMIN_TOKEN in .env.");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("Set DATABASE_URL in .env — the job engine needs Postgres.");
    process.exit(1);
  }
  return { shop, token };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}
