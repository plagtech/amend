/**
 * A rate-limit-aware wrapper around the Admin GraphQL client.
 *
 * The inline apply path fires hundreds of mutations back to back, which is
 * exactly the shape that trips Shopify's leaky-bucket limiter. Shopify tells us
 * the bucket level on every response (`extensions.cost.throttleStatus`), so the
 * honest thing to do is read it and wait rather than fire blindly and retry on
 * failure — a retry storm is what makes competitors "slow from time to time".
 *
 * Two mechanisms, in order of preference:
 *
 *   1. Proactive. Track `currentlyAvailable` and `restoreRate` from the last
 *      response and sleep until the bucket can afford the next call.
 *   2. Reactive. If a call is throttled anyway (a second process on the same
 *      shop, a cost estimate that was too low), back off and retry.
 *
 * Everything here is per-instance, so one instance per job run. That is the
 * right scope: the bucket is per shop, and a shop runs one job at a time.
 */

import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

/**
 * Points we keep in reserve before making a call. A mutation costs ~10 points
 * and the standard bucket holds 2,000 restoring at 100/s, so this is a small
 * fraction of the bucket — enough that a burst of mutations never drains it to
 * the point where a concurrent page load fails.
 */
const RESERVE_POINTS = 200;

/** Bucket assumptions used until Shopify's first response tells us the truth. */
const DEFAULT_RESTORE_RATE = 50;

const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 1000;

export interface GraphqlResult<T> {
  data: T;
  extensions?: {
    cost?: {
      actualQueryCost?: number;
      throttleStatus?: {
        maximumAvailable: number;
        currentlyAvailable: number;
        restoreRate: number;
      };
    };
  };
}

export class ThrottledAdmin {
  private available: number | null = null;
  private restoreRate = DEFAULT_RESTORE_RATE;
  /** Cost of the dearest call seen so far — the budget we wait to afford. */
  private worstCost = 10;

  private readonly admin: AdminApiContext;

  constructor(admin: AdminApiContext) {
    this.admin = admin;
  }

  /**
   * Run one operation, waiting for bucket room first and retrying if Shopify
   * throttles us anyway.
   *
   * Throws on transport failure, on a GraphQL `errors` array, and on a missing
   * `data` — all of which mean the caller cannot know whether the write landed.
   * Callers treat that as "this unit failed" and leave its snapshot rows
   * unapplied, so a resume retries them rather than assuming the worst.
   */
  async run<T = Record<string, unknown>>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      await this.waitForRoom();

      let body: (GraphqlResult<T> & { errors?: unknown }) | null = null;
      let status = 0;
      try {
        const response = await this.admin.graphql(query, { variables });
        status = response.status;
        body = (await response.json()) as GraphqlResult<T> & {
          errors?: unknown;
        };
      } catch (error) {
        lastError = error as Error;
      }

      if (body) {
        this.absorbCost(body);
        const throttled = status === 429 || isThrottled(body.errors);
        if (!throttled) {
          const message = errorMessage(body.errors);
          if (message) throw new Error(message);
          if (!body.data) throw new Error("Shopify returned no data");
          return body.data;
        }
        lastError = new Error("Throttled by Shopify");
        // A throttle means the bucket is empty regardless of what the last
        // successful response said.
        this.available = 0;
      }

      await sleep(BASE_BACKOFF_MS * 2 ** attempt);
    }

    throw lastError ?? new Error("Shopify request failed");
  }

  /** Sleep until the bucket can afford the dearest call we have seen. */
  private async waitForRoom(): Promise<void> {
    if (this.available === null) return;
    const needed = this.worstCost + RESERVE_POINTS;
    if (this.available >= needed) return;

    const deficit = needed - this.available;
    const seconds = deficit / Math.max(1, this.restoreRate);
    // Cap a single wait so a pathological restore rate can't wedge a job.
    await sleep(Math.min(seconds * 1000, 10_000));
    this.available = needed;
  }

  private absorbCost(body: GraphqlResult<unknown>): void {
    const cost = body.extensions?.cost;
    if (!cost) return;
    if (typeof cost.actualQueryCost === "number") {
      this.worstCost = Math.max(this.worstCost, cost.actualQueryCost);
    }
    const status = cost.throttleStatus;
    if (status) {
      this.available = status.currentlyAvailable;
      this.restoreRate = status.restoreRate || DEFAULT_RESTORE_RATE;
    }
  }
}

function isThrottled(errors: unknown): boolean {
  if (!Array.isArray(errors)) return false;
  return errors.some((error) => {
    const record = error as {
      extensions?: { code?: unknown };
      message?: unknown;
    };
    return (
      record.extensions?.code === "THROTTLED" ||
      String(record.message ?? "").toLowerCase().includes("throttled")
    );
  });
}

function errorMessage(errors: unknown): string | null {
  if (!Array.isArray(errors) || errors.length === 0) return null;
  return errors
    .map((error) => String((error as { message?: unknown }).message ?? error))
    .join("; ");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
