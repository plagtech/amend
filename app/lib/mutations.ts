/**
 * Snapshot rows → Shopify mutation calls.
 *
 * Pure and isomorphic on purpose. The inline path and the Bulk Operations path
 * must send byte-identical variables — otherwise a job would write different
 * values depending on how big it happened to be — so both build their calls
 * here and differ only in how they deliver them.
 *
 * Grouping is the whole job of this module. Shopify addresses variant writes by
 * product (`productVariantsBulkUpdate(productId:)`), so a job's rows have to be
 * gathered per product before anything can be sent, and the resulting call has
 * to remember which `Snapshot` rows it is answerable for — that mapping is what
 * turns a userError into "these three variants failed, and why".
 */

/**
 * The mutation types a job runs, in order.
 *
 * Bulk Operations run one mutation at a time, so a job that touches both prices
 * and tags is two sequential bulk operations. Variants go first: if a job is
 * interrupted between stages, a catalog with new prices and old tags is less
 * surprising than the reverse, and the snapshot covers both either way.
 */
export const MUTATION_STAGES = ["variant", "product"] as const;
export type MutationStage = (typeof MUTATION_STAGES)[number];

/** Which stage a `Snapshot.fieldPath` belongs to. */
export function stageOfFieldPath(fieldPath: string): MutationStage | null {
  if (fieldPath.startsWith("variant.")) return "variant";
  if (fieldPath.startsWith("product.")) return "product";
  return null;
}

/**
 * The mutation documents.
 *
 * These strings are sent verbatim to `bulkOperationRunMutation` as well as run
 * inline, so they must stay valid as standalone operations with named
 * variables — a JSONL line is exactly one of these variable objects.
 *
 * `productVariantsBulkUpdate` is deliberately left atomic (no
 * `allowPartialUpdates`): if one variant in a call is rejected the whole call
 * is, and every row in that call is reported failed. A half-applied call would
 * leave the snapshot describing a state the catalog is not in, which is the one
 * thing undo cannot survive.
 */
export const STAGE_MUTATION: Record<MutationStage, string> = {
  variant: `mutation AmendVariantsUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id price compareAtPrice }
    userErrors { field message }
  }
}`,
  product: `mutation AmendProductUpdate($product: ProductUpdateInput!) {
  productUpdate(product: $product) {
    product { id status tags }
    userErrors { field message }
  }
}`,
};

/** Response field a stage's `userErrors` live under. */
export const STAGE_PAYLOAD_FIELD: Record<MutationStage, string> = {
  variant: "productVariantsBulkUpdate",
  product: "productUpdate",
};

export const STAGE_LABEL: Record<MutationStage, string> = {
  variant: "variant fields",
  product: "product fields",
};

// --- values -----------------------------------------------------------------

/**
 * Snapshot values are JSON-encoded (see the Prisma model), which is what lets a
 * missing compare-at price and the string "null" stay different things, and a
 * tag containing a comma survive the round trip.
 */
export function decodeValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // A hand-edited row, or one written before encoding. Treat it as the
    // literal string rather than failing a whole job over one cell.
    return raw;
  }
}

export function encodeValue(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** Human-readable rendering of a stored value, for the job page. */
export function formatValue(raw: string): string {
  const value = decodeValue(raw);
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.join(", ") || "—";
  return String(value);
}

// --- units ------------------------------------------------------------------

/** The subset of a `Snapshot` row the builder reads. */
export interface SnapshotLike {
  id: string;
  ownerGid: string;
  productGid: string | null;
  fieldPath: string;
  newValue: string;
}

/**
 * One mutation call: the variables to send, and the snapshot rows whose fate it
 * decides.
 */
export interface MutationUnit {
  stage: MutationStage;
  /** The product this call addresses — one call never spans two products. */
  productGid: string;
  variables: Record<string, unknown>;
  snapshotIds: string[];
}

export interface BuildUnitsOptions {
  /**
   * Variants per call. The inline path uses `VARIANTS_PER_MUTATION` to keep
   * each request's query cost small; the bulk path leaves it unbounded, since
   * one JSONL line per product is the shape Shopify wants.
   */
  maxVariantsPerUnit?: number;
}

/**
 * Group snapshot rows into mutation calls for one stage.
 *
 * Deterministic: rows are sorted before grouping, so the same input always
 * produces the same units in the same order. The bulk path leans on that —
 * `Snapshot.bulkLine` is assigned from this order, and a result found by
 * `__lineNumber` has to land back on the rows that produced it.
 */
export function buildUnits(
  snapshots: SnapshotLike[],
  stage: MutationStage,
  { maxVariantsPerUnit = Number.POSITIVE_INFINITY }: BuildUnitsOptions = {},
): MutationUnit[] {
  const mine = snapshots
    .filter((snapshot) => stageOfFieldPath(snapshot.fieldPath) === stage)
    .sort(compareSnapshots);

  return stage === "variant"
    ? buildVariantUnits(mine, maxVariantsPerUnit)
    : buildProductUnits(mine);
}

function compareSnapshots(a: SnapshotLike, b: SnapshotLike): number {
  const product = (a.productGid ?? a.ownerGid).localeCompare(
    b.productGid ?? b.ownerGid,
  );
  if (product !== 0) return product;
  const owner = a.ownerGid.localeCompare(b.ownerGid);
  return owner !== 0 ? owner : a.fieldPath.localeCompare(b.fieldPath);
}

interface Draft {
  input: Record<string, unknown>;
  snapshotIds: string[];
}

function buildVariantUnits(
  snapshots: SnapshotLike[],
  maxVariants: number,
): MutationUnit[] {
  // product → variant → the fields that variant changes
  const byProduct = new Map<string, Map<string, Draft>>();

  for (const snapshot of snapshots) {
    // A variant row with no parent product can't be addressed. Skipping it
    // here would hide it; `unaddressableIds` fails it explicitly instead.
    const productGid = snapshot.productGid;
    if (!productGid) continue;

    let variants = byProduct.get(productGid);
    if (!variants) byProduct.set(productGid, (variants = new Map()));

    let draft = variants.get(snapshot.ownerGid);
    if (!draft) {
      variants.set(
        snapshot.ownerGid,
        (draft = { input: { id: snapshot.ownerGid }, snapshotIds: [] }),
      );
    }

    draft.input[snapshot.fieldPath.slice("variant.".length)] = decodeValue(
      snapshot.newValue,
    );
    draft.snapshotIds.push(snapshot.id);
  }

  const units: MutationUnit[] = [];
  for (const [productGid, variants] of byProduct) {
    const drafts = [...variants.values()];
    for (let i = 0; i < drafts.length; i += maxVariants) {
      const chunk = drafts.slice(i, i + maxVariants);
      units.push({
        stage: "variant",
        productGid,
        variables: {
          productId: productGid,
          variants: chunk.map((draft) => draft.input),
        },
        snapshotIds: chunk.flatMap((draft) => draft.snapshotIds),
      });
    }
  }
  return units;
}

function buildProductUnits(snapshots: SnapshotLike[]): MutationUnit[] {
  const byProduct = new Map<string, Draft>();

  for (const snapshot of snapshots) {
    let draft = byProduct.get(snapshot.ownerGid);
    if (!draft) {
      byProduct.set(
        snapshot.ownerGid,
        (draft = { input: { id: snapshot.ownerGid }, snapshotIds: [] }),
      );
    }
    draft.input[snapshot.fieldPath.slice("product.".length)] = decodeValue(
      snapshot.newValue,
    );
    draft.snapshotIds.push(snapshot.id);
  }

  return [...byProduct.entries()].map(([productGid, draft]) => ({
    stage: "product" as const,
    productGid,
    variables: { product: draft.input },
    snapshotIds: draft.snapshotIds,
  }));
}

/**
 * Rows a stage cannot address at all — a variant row that lost its parent
 * product reference. Failed explicitly rather than silently dropped: a snapshot
 * row that is neither applied nor failed would leave its job hanging forever.
 */
export function unaddressableIds(
  snapshots: SnapshotLike[],
  stage: MutationStage,
): string[] {
  if (stage !== "variant") return [];
  return snapshots
    .filter(
      (snapshot) =>
        stageOfFieldPath(snapshot.fieldPath) === "variant" &&
        !snapshot.productGid,
    )
    .map((snapshot) => snapshot.id);
}

// --- results ----------------------------------------------------------------

/**
 * The `userErrors` message from one mutation response payload, or null when the
 * call succeeded. Shape-tolerant on purpose: this parses both a live GraphQL
 * response body's `data` and a line of a bulk result file, which carry the same
 * payload under the same key.
 */
export function readUserError(
  payload: unknown,
  stage: MutationStage,
): string | null {
  if (!payload || typeof payload !== "object") return "No response from Shopify";
  const body = payload as Record<string, unknown>;
  const field = body[STAGE_PAYLOAD_FIELD[stage]] as
    | Record<string, unknown>
    | undefined;
  if (!field) return "No response from Shopify";

  const errors = field.userErrors;
  if (!Array.isArray(errors) || errors.length === 0) return null;

  return (
    errors
      .map((error) => {
        const record = error as { field?: unknown; message?: unknown };
        const path = Array.isArray(record.field)
          ? record.field
              .filter((part): part is string => typeof part === "string")
              .join(".")
          : null;
        const message = String(record.message ?? "Rejected by Shopify");
        return path ? `${path}: ${message}` : message;
      })
      .join("; ") || "Rejected by Shopify"
  );
}
