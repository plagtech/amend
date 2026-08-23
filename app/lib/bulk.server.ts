/**
 * The Bulk Operations path: staged JSONL upload, `bulkOperationRunMutation`,
 * and reading the results file back.
 *
 * Above `SYNC_ITEM_LIMIT` this is how a job runs. One request hands Shopify the
 * whole edit and Shopify applies it on its own schedule with no rate limiting,
 * which is where the "fast, even at 3,000 variants" claim comes from.
 *
 * The cost is that it is asynchronous, so this module only *starts* things. The
 * job resumes when `bulk_operations/finish` arrives (or when the stale sweep
 * polls, for a webhook that never did) — see `apply.server.ts`.
 */

import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

import type { MutationStage, MutationUnit } from "./mutations";
import { STAGE_MUTATION } from "./mutations";
import { ThrottledAdmin } from "./throttle.server";

const STAGED_UPLOAD_MUTATION = `#graphql
  mutation AmendStagedUpload($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters {
          name
          value
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const RUN_MUTATION = `#graphql
  mutation AmendBulkRun($mutation: String!, $path: String!) {
    bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $path) {
      bulkOperation {
        id
        status
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const OPERATION_QUERY = `#graphql
  query AmendBulkOperation($id: ID!) {
    node(id: $id) {
      ... on BulkOperation {
        id
        status
        errorCode
        objectCount
        url
        partialDataUrl
      }
    }
  }
`;

export interface BulkOperationNode {
  id: string;
  status:
    | "CREATED"
    | "RUNNING"
    | "COMPLETED"
    | "FAILED"
    | "CANCELED"
    | "CANCELING"
    | "EXPIRED";
  errorCode: string | null;
  objectCount: string;
  /** Results file. Present only once the operation has COMPLETED. */
  url: string | null;
  /** What did land before the operation gave up. Present on FAILED/CANCELED. */
  partialDataUrl: string | null;
}

/**
 * Upload one stage's mutation variables and start the operation.
 *
 * Each unit becomes one JSONL line, in the order given — which is the order
 * `Snapshot.bulkLine` was assigned in — because a result line identifies itself
 * only by `__lineNumber`.
 */
export async function startBulkStage(
  admin: AdminApiContext,
  stage: MutationStage,
  units: MutationUnit[],
): Promise<string> {
  const client = new ThrottledAdmin(admin);
  const jsonl = units.map((unit) => JSON.stringify(unit.variables)).join("\n");

  const staged = await client.run<{
    stagedUploadsCreate: {
      stagedTargets: {
        url: string;
        parameters: { name: string; value: string }[];
      }[];
      userErrors: { field: string[] | null; message: string }[];
    };
  }>(STAGED_UPLOAD_MUTATION, {
    input: [
      {
        resource: "BULK_MUTATION_VARIABLES",
        filename: `amend_${stage}_${units.length}.jsonl`,
        mimeType: "text/jsonl",
        httpMethod: "POST",
      },
    ],
  });

  const errors = staged.stagedUploadsCreate.userErrors;
  if (errors.length) {
    throw new Error(
      `Could not stage the upload: ${errors.map((e) => e.message).join("; ")}`,
    );
  }
  const target = staged.stagedUploadsCreate.stagedTargets[0];
  if (!target) throw new Error("Shopify returned no upload target");

  const form = new FormData();
  for (const parameter of target.parameters) {
    form.append(parameter.name, parameter.value);
  }
  // The file part must come last — the storage backend ignores parameters that
  // follow it.
  form.append("file", new Blob([jsonl], { type: "text/jsonl" }), "amend.jsonl");

  const upload = await fetch(target.url, { method: "POST", body: form });
  if (!upload.ok) {
    throw new Error(
      `Upload of the edit failed (HTTP ${upload.status}): ${await upload
        .text()
        .catch(() => "")}`.trim(),
    );
  }

  const key = target.parameters.find((p) => p.name === "key")?.value;
  if (!key) throw new Error("Staged upload returned no key");

  const run = await client.run<{
    bulkOperationRunMutation: {
      bulkOperation: { id: string; status: string } | null;
      userErrors: { field: string[] | null; message: string; code: string | null }[];
    };
  }>(RUN_MUTATION, { mutation: STAGE_MUTATION[stage], path: key });

  const runErrors = run.bulkOperationRunMutation.userErrors;
  if (runErrors.length || !run.bulkOperationRunMutation.bulkOperation) {
    throw new Error(
      `Shopify refused the bulk operation: ${
        runErrors.map((e) => e.message).join("; ") || "no operation returned"
      }`,
    );
  }

  return run.bulkOperationRunMutation.bulkOperation.id;
}

export async function fetchBulkOperation(
  admin: AdminApiContext,
  gid: string,
): Promise<BulkOperationNode | null> {
  const client = new ThrottledAdmin(admin);
  const data = await client.run<{ node: BulkOperationNode | null }>(
    OPERATION_QUERY,
    { id: gid },
  );
  return data.node;
}

/**
 * Results keyed by the line they answer.
 *
 * A completed operation returns one line per input line, but a failed one
 * returns only what it managed — so a missing key means "not attempted", which
 * is exactly what leaves those snapshot rows unapplied and retryable.
 */
export async function fetchBulkResults(
  url: string,
): Promise<Map<number, unknown>> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not download the bulk results (HTTP ${response.status})`);
  }
  const body = await response.text();
  const results = new Map<number, unknown>();

  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: { __lineNumber?: unknown; data?: unknown };
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed.__lineNumber !== "number") continue;
    // Shopify wraps each result as {"data": {...}, "__lineNumber": n}. Falling
    // back to the whole object keeps this working if a line ever arrives
    // unwrapped — `readUserError` looks for the payload field either way.
    results.set(parsed.__lineNumber, parsed.data ?? parsed);
  }

  return results;
}
