import { randomUUID } from "node:crypto";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import {
  useFetcher,
  useLoaderData,
  useNavigate,
  useNavigation,
  useSearchParams,
} from "@remix-run/react";
import {
  ActionList,
  Autocomplete,
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  ButtonGroup,
  Card,
  ChoiceList,
  EmptyState,
  IndexFilters,
  IndexTable,
  IndexTableSelectionType,
  InlineStack,
  Layout,
  List,
  Modal,
  Page,
  Popover,
  Select,
  Tag,
  Text,
  TextField,
  Thumbnail,
  useSetIndexFiltersMode,
} from "@shopify/polaris";
import { ImageIcon, PlusIcon } from "@shopify/polaris-icons";
import { TitleBar } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import {
  JobRequestError,
  PlanLimitError,
  createApplyJob,
  runJobDetached,
} from "../lib/apply.server";
import { describeActions, jobName } from "../lib/jobs";
import {
  coerceSelection,
  selectionSignature,
  useSelection,
} from "../lib/use-selection";
import type { EditAction, PreviewRow } from "../lib/actions";
import {
  ACTION_TYPES,
  actionsSignature,
  isActionComplete,
  newAction,
  parseActions,
} from "../lib/actions";
import type { PreviewResult } from "../lib/preview.server";
import { buildPreview } from "../lib/preview.server";
import type { JobScope } from "../lib/snapshots.server";
import type { ProductStatus, SelectFilters, SelectView } from "../lib/filters";
import {
  PRODUCT_STATUSES,
  activeFilterCount,
  emptyFilters,
  filterSignature,
  hasVariantLevelFilters,
  parseFilters,
  serializeFilters,
} from "../lib/filters";
import type {
  FacetOption,
  ProductPage,
  ProductRow,
  VariantRow,
} from "../lib/catalog";
import {
  PREVIEW_PRODUCT_CAP,
  PRODUCT_PAGE_SIZE,
  SORT_OPTIONS,
  VARIANT_VIEW_PAGE_SIZE,
  isSortKey,
} from "../lib/catalog";
import { fetchFacets, fetchProductPage } from "../lib/products.server";

const DEFAULT_SORT = "TITLE asc";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const params = url.searchParams;

  const filters = parseFilters(params);
  const [rawKey, rawDirection] = (params.get("sort") ?? DEFAULT_SORT).split(" ");
  const sortKey = isSortKey(rawKey) ? rawKey : "TITLE";
  const reverse = rawDirection === "desc";
  const cursor = params.get("cursor");
  const direction = params.get("dir") === "prev" ? "prev" : "next";

  const [page, facets] = await Promise.all([
    fetchProductPage(admin, { filters, sortKey, reverse, cursor, direction }),
    fetchFacets(admin),
  ]);

  return {
    page,
    facets,
    filters,
    sort: `${sortKey} ${reverse ? "desc" : "asc"}`,
  };
};

/** What the Apply branch of the action hands back to the browser. */
export interface ApplyResponse {
  jobId: string | null;
  error: string | null;
}

/**
 * A preview, plus the one key that can turn it into a write.
 *
 * Minted per preview rather than per page load, because the preview is the unit
 * the merchant actually approves: change the filter, the selection or the
 * actions and the diff table is invalidated, a new preview is required, and
 * that new preview carries a new key. A second deliberate application of the
 * same edit therefore still works — it goes through a second preview. What
 * cannot happen is the *same* approved diff being applied twice.
 */
export type PreviewResponse = PreviewResult & { idempotencyKey: string };

/**
 * Preview and Apply. Both POSTed rather than folded into the loader because the
 * selection can be thousands of ids — that belongs in a body, not a URL — and
 * because both are explicit, comparatively expensive steps the merchant asks
 * for, not something that should run on every filter keystroke.
 *
 * Apply deliberately posts the same four things Preview does, plus the rows the
 * merchant unticked. It does NOT post the diff rows: the server re-resolves the
 * selection and recomputes every value with the same code that produced the
 * preview, so a tampered or stale row list cannot become a write. Everything
 * past creating the job happens in the background — see `apply.server.ts`.
 *
 * Apply also posts back the key its preview was issued with. A confirm POST
 * that arrives twice for one preview — a retried fetch, a second tab, a
 * double-submit — resolves to the job the first one created and navigates to
 * the same page. The merchant sees one edit because there is one edit.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const body = (await request.json()) as {
    intent?: string;
    filters?: string;
    actions?: string;
    selection?: unknown;
    sort?: string;
    excluded?: unknown;
    scopeLabel?: string;
    idempotencyKey?: string;
  };

  const filters = parseFilters(new URLSearchParams(body.filters ?? ""));
  const [rawKey, rawDirection] = (body.sort ?? DEFAULT_SORT).split(" ");
  const sortKey = isSortKey(rawKey) ? rawKey : "TITLE";
  const reverse = rawDirection === "desc";
  const actions = parseActions(body.actions);
  const selection = coerceSelection(body.selection);

  if (body.intent === "apply") {
    const scope: JobScope = {
      filters,
      selection,
      excluded: Array.isArray(body.excluded)
        ? body.excluded.filter((id): id is string => typeof id === "string")
        : [],
      sortKey,
      reverse,
    };
    try {
      const job = await createApplyJob({
        shopId: session.shop,
        name: jobName(actions, String(body.scopeLabel ?? "").slice(0, 60)),
        scope,
        actions,
        idempotencyKey:
          typeof body.idempotencyKey === "string" ? body.idempotencyKey : "",
      });
      runJobDetached(session.shop, job.id);
      return { jobId: job.id, error: null } satisfies ApplyResponse;
    } catch (error) {
      if (error instanceof PlanLimitError || error instanceof JobRequestError) {
        return { jobId: null, error: error.message } satisfies ApplyResponse;
      }
      throw error;
    }
  }

  const preview = await buildPreview(admin, {
    filters,
    actions,
    selection,
    sortKey,
    reverse,
  });
  // The key rides back with the diff the merchant is about to approve, and is
  // spent by whichever confirm POST reaches the server first.
  return { ...preview, idempotencyKey: randomUUID() } satisfies PreviewResponse;
};

export default function NewBulkEdit() {
  const { page, facets, filters, sort } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigation = useNavigation();
  const { mode, setMode } = useSetIndexFiltersMode();

  const loading = navigation.state === "loading";
  const variantView = filters.view === "variant";
  const selection = useSelectionForFilters(filters);

  // --- edit actions ---------------------------------------------------------

  const [actions, setActions] = useState<EditAction[]>([]);
  const completeActions = useMemo(
    () => actions.filter(isActionComplete),
    [actions],
  );

  const addAction = useCallback(
    (type: EditAction["type"]) =>
      setActions((current) => [...current, newAction(type)]),
    [],
  );
  const updateAction = useCallback(
    (index: number, next: EditAction) =>
      setActions((current) =>
        current.map((action, i) => (i === index ? next : action)),
      ),
    [],
  );
  const removeAction = useCallback(
    (index: number) =>
      setActions((current) => current.filter((_, i) => i !== index)),
    [],
  );

  // --- preview --------------------------------------------------------------

  const previewFetcher = useFetcher<PreviewResponse>();

  /**
   * Identity of what a preview describes. Any change to the filter, the
   * selection or the actions makes an existing diff table a lie, so the preview
   * is hidden until it is regenerated rather than left on screen looking valid.
   */
  const previewKey = useMemo(
    () =>
      [
        filterSignature(filters),
        sort,
        selectionSignature(selection.selection),
        actionsSignature(actions),
      ].join("|"),
    [filters, sort, selection.selection, actions],
  );
  const [previewedKey, setPreviewedKey] = useState<string | null>(null);
  const [excluded, setExcluded] = useState<string[]>([]);

  const previewing = previewFetcher.state !== "idle";
  const preview =
    previewedKey === previewKey && previewFetcher.data
      ? previewFetcher.data
      : null;

  const runPreview = useCallback(() => {
    setPreviewedKey(previewKey);
    setExcluded([]);
    previewFetcher.submit(
      {
        filters: serializeFilters(filters).toString(),
        actions: JSON.stringify(actions),
        selection: selection.selection,
        sort,
      },
      { method: "POST", encType: "application/json" },
    );
  }, [previewFetcher, previewKey, filters, actions, selection.selection, sort]);

  const selectionEmpty =
    selection.selection.mode === "some" && selection.selection.ids.length === 0;
  const canPreview = !selectionEmpty && completeActions.length > 0;

  // --- apply ----------------------------------------------------------------

  const applyFetcher = useFetcher<ApplyResponse>();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);

  const summary = useMemo(
    () => includedSummary(preview, new Set(excluded)),
    [preview, excluded],
  );

  /**
   * SPEC §6: Apply stays off until a preview exists — force the safe path. It
   * is off for a stale one too, because `preview` goes null the moment the
   * filter, selection or actions move away from what was previewed.
   */
  const canApply = preview !== null && summary.rows > 0;
  const applying = applyFetcher.state !== "idle";

  const runApply = useCallback(() => {
    // `canApply` already gates the button on a live preview; this is the same
    // condition restated where the key is actually read, so a future caller
    // cannot reach the POST without one.
    if (!preview) return;
    setConfirming(false);
    applyFetcher.submit(
      {
        intent: "apply",
        filters: serializeFilters(filters).toString(),
        actions: JSON.stringify(actions),
        selection: selection.selection,
        sort,
        excluded,
        scopeLabel: describeScope(filters, facets.collections),
        // Spent by the first POST to arrive. A replay of this exact body lands
        // back on the job that POST created rather than starting a second one.
        idempotencyKey: preview.idempotencyKey,
      },
      { method: "POST", encType: "application/json" },
    );
  }, [
    applyFetcher,
    preview,
    filters,
    actions,
    selection.selection,
    sort,
    excluded,
    facets.collections,
  ]);

  // Once a job exists it, not this page, is where progress, failures and Undo
  // live — so the merchant goes there rather than being left on a stale diff.
  const createdJobId = applyFetcher.data?.jobId ?? null;
  useEffect(() => {
    if (createdJobId) navigate(`/app/jobs/${createdJobId}`);
  }, [createdJobId, navigate]);

  // --- navigation helpers ---------------------------------------------------

  /** Any filter change resets pagination — cursors don't survive a new query. */
  const applyFilters = useCallback(
    (next: SelectFilters) => {
      const params = serializeFilters(next);
      const currentSort = searchParams.get("sort");
      if (currentSort && currentSort !== DEFAULT_SORT) {
        params.set("sort", currentSort);
      }
      setSearchParams(params, { replace: true, preventScrollReset: true });
    },
    [searchParams, setSearchParams],
  );

  const patchFilters = useCallback(
    (patch: Partial<SelectFilters>) => applyFilters({ ...filters, ...patch }),
    [applyFilters, filters],
  );

  const goToPage = useCallback(
    (cursor: string | null, direction: "next" | "prev") => {
      if (!cursor) return;
      const params = new URLSearchParams(searchParams);
      params.set("cursor", cursor);
      params.set("dir", direction);
      setSearchParams(params, { preventScrollReset: true });
    },
    [searchParams, setSearchParams],
  );

  // --- search box (debounced so we don't navigate per keystroke) ------------

  const [queryValue, setQueryValue] = useState(filters.search);

  // Refs so the debounce depends only on primitives. Depending on `filters` or
  // `applyFilters` would reset the timer on every render and it could never
  // fire.
  const latest = useRef({ filters, applyFilters });
  latest.current = { filters, applyFilters };

  useEffect(() => {
    if (queryValue === filters.search) return;
    const timer = setTimeout(() => {
      const { filters: current, applyFilters: apply } = latest.current;
      apply({ ...current, search: queryValue });
    }, 350);
    return () => clearTimeout(timer);
  }, [queryValue, filters.search]);

  const clearAll = useCallback(() => {
    setQueryValue("");
    applyFilters({ ...emptyFilters(), view: filters.view });
  }, [applyFilters, filters.view]);

  // --- rows -----------------------------------------------------------------

  const rows = useMemo(
    () => buildRowModel(page.products, variantView),
    [page.products, variantView],
  );
  const positionIds = useMemo(
    () => rows.map((row) => (row.kind === "group" ? null : row.id)),
    [rows],
  );

  const handleSelectionChange = useCallback(
    (
      selectionType: IndexTableSelectionType,
      isSelecting: boolean,
      selectionId?: string | [number, number],
    ) => {
      switch (selectionType) {
        case IndexTableSelectionType.All:
          if (isSelecting) selection.selectAllMatching();
          else selection.clear();
          return;
        case IndexTableSelectionType.Page:
          selection.setMany(page.rowIds, isSelecting);
          return;
        case IndexTableSelectionType.Multi:
        case IndexTableSelectionType.Range: {
          if (!Array.isArray(selectionId)) return;
          const [start, end] = selectionId;
          const ids = positionIds
            .slice(start, end + 1)
            .filter((id): id is string => Boolean(id));
          selection.setMany(ids, isSelecting);
          return;
        }
        case IndexTableSelectionType.Single:
          if (typeof selectionId === "string") {
            selection.toggle(selectionId, isSelecting);
          }
      }
    },
    [page.rowIds, positionIds, selection],
  );

  const selectedCount = selection.count(
    variantView ? estimateVariantTotal(page) : page.totalProducts,
  );
  const excludedCount =
    selection.selection.mode === "all" ? selection.selection.excluded.length : 0;
  /** Only a clean select-all is "All" — one unchecked row makes it a number. */
  const everythingSelected = selection.isSelectAll && excludedCount === 0;

  // --- render ---------------------------------------------------------------

  const resourceName = variantView
    ? { singular: "variant", plural: "variants" }
    : { singular: "product", plural: "products" };

  return (
    <Page
      backAction={{ content: "Amend", url: "/app" }}
      title="New bulk edit"
      subtitle="Select products, stack edit actions, preview every change"
      primaryAction={{
        content: "Apply changes",
        disabled: !canApply || applying,
        loading: applying,
        onAction: () => setConfirming(true),
        helpText: canApply
          ? undefined
          : "Preview the changes first — nothing can be applied without a diff to approve",
      }}
    >
      <TitleBar title="New bulk edit" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {applyFetcher.data?.error ? (
              <Banner tone="critical" title="This edit was not started">
                <p>{applyFetcher.data.error}</p>
              </Banner>
            ) : null}

            <ViewToggle
              view={filters.view}
              onChange={(view) => patchFilters({ view })}
            />

            <Card padding="0">
              <IndexFilters
                queryValue={queryValue}
                queryPlaceholder="Search products by title, SKU, or vendor"
                onQueryChange={setQueryValue}
                onQueryClear={() => setQueryValue("")}
                onClearAll={clearAll}
                filters={buildFilterDescriptors(filters, facets, patchFilters)}
                appliedFilters={buildAppliedFilters(filters, facets, patchFilters)}
                sortOptions={sortChoices()}
                sortSelected={[sort]}
                onSort={([value]) => {
                  const params = new URLSearchParams(searchParams);
                  params.set("sort", value);
                  params.delete("cursor");
                  params.delete("dir");
                  setSearchParams(params, { preventScrollReset: true });
                }}
                tabs={[]}
                selected={0}
                onSelect={() => {}}
                canCreateNewView={false}
                mode={mode}
                setMode={setMode}
                loading={loading}
              />

              <IndexTable
                resourceName={resourceName}
                itemCount={page.rowIds.length}
                selectedItemsCount={everythingSelected ? "All" : selectedCount}
                onSelectionChange={handleSelectionChange}
                hasMoreItems={page.pageInfo.hasNextPage}
                loading={loading}
                paginatedSelectAllActionText={`Select all ${formatCount(
                  page.totalProducts,
                  page.totalIsLowerBound,
                )} products matching this filter`}
                paginatedSelectAllText={selectAllSummary(page, variantView)}
                bulkActions={[
                  { content: "Clear selection", onAction: selection.clear },
                ]}
                headings={
                  variantView
                    ? [
                        { title: "Product / variant" },
                        { title: "SKU" },
                        { title: "Status" },
                        { title: "Price", alignment: "end" },
                        { title: "Compare at", alignment: "end" },
                        { title: "Inventory", alignment: "end" },
                      ]
                    : [
                        { title: "Product" },
                        { title: "Status" },
                        { title: "Vendor" },
                        { title: "Type" },
                        { title: "Variants", alignment: "end" },
                        { title: "Inventory", alignment: "end" },
                        { title: "Price", alignment: "end" },
                      ]
                }
                emptyState={
                  <EmptyState
                    heading="No products match this filter"
                    action={{ content: "Clear filters", onAction: clearAll }}
                    image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                  >
                    <p>
                      Widen the filter, or clear it to start from the whole
                      catalog.
                    </p>
                  </EmptyState>
                }
                pagination={{
                  hasNext: page.pageInfo.hasNextPage,
                  hasPrevious: page.pageInfo.hasPreviousPage,
                  onNext: () => goToPage(page.pageInfo.endCursor, "next"),
                  onPrevious: () => goToPage(page.pageInfo.startCursor, "prev"),
                }}
              >
                {rows.map((row) =>
                  row.kind === "product" ? (
                    <ProductTableRow
                      key={row.id}
                      row={row}
                      selected={selection.isSelected(row.id)}
                    />
                  ) : row.kind === "group" ? (
                    <GroupTableRow
                      key={`group-${row.product.id}`}
                      row={row}
                      selected={groupSelectionState(row, selection.isSelected)}
                    />
                  ) : (
                    <VariantTableRow
                      key={row.id}
                      row={row}
                      selected={selection.isSelected(row.id)}
                    />
                  ),
                )}
              </IndexTable>
            </Card>

            <SelectionSummary
              page={page}
              variantView={variantView}
              filterCount={activeFilterCount(filters)}
              selectedCount={selectedCount}
              isSelectAll={selection.isSelectAll}
              excludedCount={excludedCount}
              onSelectAllMatching={selection.selectAllMatching}
              onSelectPage={() => selection.setMany(page.rowIds, true)}
              onClear={selection.clear}
            />

            {variantView && hasVariantLevelFilters(filters) ? (
              <Banner tone="info">
                <p>
                  Price, SKU, and inventory filters are matched against each
                  variant, so a product may show fewer variants than it has.
                </p>
              </Banner>
            ) : null}

            <ActionsBuilder
              actions={actions}
              onAdd={addAction}
              onUpdate={updateAction}
              onRemove={removeAction}
            />

            <PreviewSection
              preview={preview}
              previewing={previewing}
              canPreview={canPreview}
              stale={previewedKey !== null && previewedKey !== previewKey}
              selectionEmpty={selectionEmpty}
              hasActions={completeActions.length > 0}
              excluded={excluded}
              onExcludedChange={setExcluded}
              onRun={runPreview}
            />
          </BlockStack>
        </Layout.Section>
      </Layout>

      <ApplyConfirmModal
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={runApply}
        applying={applying}
        actions={completeActions}
        summary={summary}
        scopeLabel={describeScope(filters, facets.collections)}
      />
    </Page>
  );
}

// --- apply ------------------------------------------------------------------

/**
 * The last thing between a merchant and their catalog.
 *
 * It restates the counts, the actions, and what they are being applied to,
 * because "312 products · 894 variants" is the number a merchant checks against
 * what they meant to do — and it says plainly that the undo data is written
 * first, which is what makes clicking Apply a reasonable thing to do.
 */
function ApplyConfirmModal({
  open,
  onClose,
  onConfirm,
  applying,
  actions,
  summary,
  scopeLabel,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  applying: boolean;
  actions: EditAction[];
  summary: IncludedSummary;
  scopeLabel: string;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Apply this edit?"
      primaryAction={{
        content: `Apply ${summary.rows.toLocaleString()} change${
          summary.rows === 1 ? "" : "s"
        }`,
        onAction: onConfirm,
        loading: applying,
      }}
      secondaryActions={[{ content: "Cancel", onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <Banner tone="warning">
            <p>
              This writes to{" "}
              <strong>
                {summary.products.toLocaleString()}{" "}
                {summary.products === 1 ? "product" : "products"}
              </strong>
              {summary.variants > 0 ? (
                <>
                  {" and "}
                  <strong>
                    {summary.variants.toLocaleString()}{" "}
                    {summary.variants === 1 ? "variant" : "variants"}
                  </strong>
                </>
              ) : null}{" "}
              in {scopeLabel}.
            </p>
          </Banner>

          <BlockStack gap="100">
            <Text as="h3" variant="headingSm">
              What will be changed
            </Text>
            <List>
              {actions.map((action, index) => (
                <List.Item key={index}>{describeActions([action])}</List.Item>
              ))}
            </List>
          </BlockStack>

          <Text as="p" variant="bodySm" tone="subdued">
            Every value this edit overwrites is saved before the first change is
            written. Undo restores all of them in one click — free, on any plan.
          </Text>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

interface IncludedSummary {
  products: number;
  variants: number;
  rows: number;
  /** False once the row limit clips the table and the server's counts stand. */
  exact: boolean;
}

/**
 * What is actually going to be applied, after per-row exclusions.
 *
 * Exact whenever every changed row is on screen. Past `PREVIEW_ROW_LIMIT` we
 * cannot recount products from what is visible, so the server's totals stand
 * and exclusions only account for the rows the merchant could see.
 */
function includedSummary(
  preview: PreviewResult | null,
  excludedSet: Set<string>,
): IncludedSummary {
  if (!preview) return { products: 0, variants: 0, rows: 0, exact: true };

  const included = preview.rows.filter((row) => !excludedSet.has(row.id));
  const exact = !preview.rowsTruncated;

  return {
    products: exact
      ? new Set(included.map((row) => row.productId)).size
      : preview.productsChanged,
    variants: exact
      ? included.filter((row) => row.kind === "variant").length
      : preview.variantsChanged,
    rows: exact
      ? included.length
      : Math.max(0, preview.totalRows - excludedSet.size),
    exact,
  };
}

/**
 * A short name for what the edit was applied to, for the job's auto-title.
 * Collections first — "Price −15% on Summer Sale" is how a merchant describes
 * the edit they just ran.
 */
function describeScope(
  filters: SelectFilters,
  collections: FacetOption[],
): string {
  if (filters.collectionId) {
    const label = collections.find(
      (option) => option.value === filters.collectionId,
    )?.label;
    // Facet labels carry a "(123)" product count that has no place in a name.
    if (label) return label.replace(/\s*\(\d[\d,]*\)$/, "");
  }
  if (filters.vendors.length === 1) return filters.vendors[0];
  if (filters.productTypes.length === 1) return filters.productTypes[0];
  if (filters.tags.length === 1) return `tag "${filters.tags[0]}"`;
  if (filters.search) return `"${filters.search}"`;

  const count = activeFilterCount(filters);
  return count > 0 ? `${count} filters` : "all products";
}

// --- selection --------------------------------------------------------------

function useSelectionForFilters(filters: SelectFilters) {
  return useSelection(filterSignature(filters));
}

function groupSelectionState(
  row: GroupRow,
  isSelected: (id: string) => boolean,
): boolean | "indeterminate" {
  const selected = row.variantIds.filter(isSelected).length;
  if (selected === 0) return false;
  return selected === row.variantIds.length ? true : "indeterminate";
}

// --- row model --------------------------------------------------------------

interface ProductRowModel {
  kind: "product";
  id: string;
  position: number;
  product: ProductRow;
}

interface GroupRow {
  kind: "group";
  position: number;
  product: ProductRow;
  range: [number, number];
  variantIds: string[];
}

interface VariantRowModel {
  kind: "variant";
  id: string;
  position: number;
  product: ProductRow;
  variant: VariantRow;
}

type RowModel = ProductRowModel | GroupRow | VariantRowModel;

/**
 * Flattens the page into positioned rows. Positions must be contiguous and
 * global for Polaris shift-select and for `selectionRange` on the product
 * subheader row, which is what makes "select this product's variants" work.
 */
function buildRowModel(products: ProductRow[], variantView: boolean): RowModel[] {
  const rows: RowModel[] = [];
  let position = 0;

  for (const product of products) {
    if (!variantView) {
      rows.push({ kind: "product", id: product.id, position, product });
      position += 1;
      continue;
    }
    if (product.variants.length === 0) continue;

    const first = position + 1;
    const last = position + product.variants.length;
    rows.push({
      kind: "group",
      position,
      product,
      range: [first, last],
      variantIds: product.variants.map((variant) => variant.id),
    });
    position += 1;

    for (const variant of product.variants) {
      rows.push({ kind: "variant", id: variant.id, position, product, variant });
      position += 1;
    }
  }

  return rows;
}

// --- table rows -------------------------------------------------------------

function ProductTableRow({
  row,
  selected,
}: {
  row: ProductRowModel;
  selected: boolean;
}) {
  const { product } = row;
  return (
    <IndexTable.Row id={row.id} position={row.position} selected={selected}>
      <IndexTable.Cell>
        <InlineStack gap="300" blockAlign="center" wrap={false}>
          <Thumbnail
            size="small"
            source={product.imageUrl ?? ImageIcon}
            alt={product.imageAlt ?? product.title}
          />
          <BlockStack gap="050">
            <Text as="span" variant="bodyMd" fontWeight="semibold">
              {product.title}
            </Text>
            {product.tags.length ? (
              <Text as="span" variant="bodySm" tone="subdued">
                {product.tags.slice(0, 4).join(", ")}
                {product.tags.length > 4 ? ` +${product.tags.length - 4}` : ""}
              </Text>
            ) : null}
          </BlockStack>
        </InlineStack>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <StatusBadge status={product.status} />
      </IndexTable.Cell>
      <IndexTable.Cell>{product.vendor || "—"}</IndexTable.Cell>
      <IndexTable.Cell>{product.productType || "—"}</IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" numeric alignment="end">
          {product.variantCount}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" numeric alignment="end">
          {product.totalInventory}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" numeric alignment="end">
          {priceRange(product)}
        </Text>
      </IndexTable.Cell>
    </IndexTable.Row>
  );
}

function GroupTableRow({
  row,
  selected,
}: {
  row: GroupRow;
  selected: boolean | "indeterminate";
}) {
  const { product } = row;
  return (
    <IndexTable.Row
      rowType="subheader"
      id={`group-${product.id}`}
      position={row.position}
      selected={selected}
      selectionRange={row.range}
      accessibilityLabel={`Select all variants of ${product.title}`}
    >
      <IndexTable.Cell>
        <InlineStack gap="300" blockAlign="center" wrap={false}>
          <Thumbnail
            size="extraSmall"
            source={product.imageUrl ?? ImageIcon}
            alt={product.imageAlt ?? product.title}
          />
          <Text as="span" variant="bodyMd" fontWeight="semibold">
            {product.title}
          </Text>
          <StatusBadge status={product.status} />
          {row.product.moreVariants > 0 ? (
            <Text as="span" variant="bodySm" tone="subdued">
              +{row.product.moreVariants} more variants not shown
            </Text>
          ) : null}
        </InlineStack>
      </IndexTable.Cell>
      <IndexTable.Cell />
      <IndexTable.Cell />
      <IndexTable.Cell />
      <IndexTable.Cell />
      <IndexTable.Cell />
    </IndexTable.Row>
  );
}

function VariantTableRow({
  row,
  selected,
}: {
  row: VariantRowModel;
  selected: boolean;
}) {
  const { variant, product } = row;
  return (
    <IndexTable.Row
      rowType="child"
      id={row.id}
      position={row.position}
      selected={selected}
    >
      <IndexTable.Cell>
        <Text as="span" variant="bodyMd">
          {variant.title}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>{variant.sku || "—"}</IndexTable.Cell>
      <IndexTable.Cell>
        <StatusBadge status={product.status} />
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" numeric alignment="end">
          {money(variant.price, product.currencyCode)}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" numeric alignment="end" tone="subdued">
          {variant.compareAtPrice
            ? money(variant.compareAtPrice, product.currencyCode)
            : "—"}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" numeric alignment="end">
          {variant.inventoryQuantity ?? 0}
        </Text>
      </IndexTable.Cell>
    </IndexTable.Row>
  );
}

function StatusBadge({ status }: { status: ProductStatus }) {
  const tone =
    status === "ACTIVE" ? "success" : status === "DRAFT" ? "info" : undefined;
  const label =
    status === "ACTIVE" ? "Active" : status === "DRAFT" ? "Draft" : "Archived";
  return <Badge tone={tone}>{label}</Badge>;
}

// --- view toggle ------------------------------------------------------------

function ViewToggle({
  view,
  onChange,
}: {
  view: SelectView;
  onChange: (view: SelectView) => void;
}) {
  return (
    <InlineStack align="space-between" blockAlign="center">
      <ButtonGroup variant="segmented">
        <Button
          pressed={view === "product"}
          onClick={() => onChange("product")}
        >
          Products
        </Button>
        <Button
          pressed={view === "variant"}
          onClick={() => onChange("variant")}
        >
          Variants
        </Button>
      </ButtonGroup>
      <Text as="span" variant="bodySm" tone="subdued">
        {view === "product"
          ? `${PRODUCT_PAGE_SIZE} products per page`
          : `${VARIANT_VIEW_PAGE_SIZE} products per page, grouped by variant`}
      </Text>
    </InlineStack>
  );
}

// --- selection summary ------------------------------------------------------

function SelectionSummary({
  page,
  variantView,
  filterCount,
  selectedCount,
  isSelectAll,
  excludedCount,
  onSelectAllMatching,
  onSelectPage,
  onClear,
}: {
  page: ProductPage;
  variantView: boolean;
  filterCount: number;
  selectedCount: number;
  isSelectAll: boolean;
  excludedCount: number;
  onSelectAllMatching: () => void;
  onSelectPage: () => void;
  onClear: () => void;
}) {
  const matching = formatCount(page.totalProducts, page.totalIsLowerBound);
  const scope = filterCount > 0 ? "matching this filter" : "in this catalog";
  const unit = variantView ? "variants" : "products";

  // In variant view a select-all spans every variant of every matching
  // product, which is a product count we know exactly — so say that, rather
  // than quoting a variant number we'd have to guess at.
  const headline = isSelectAll
    ? variantView
      ? `All variants of ${matching} products ${scope}${
          excludedCount ? `, minus ${excludedCount} excluded` : ""
        }`
      : excludedCount
        ? `${selectedCount.toLocaleString()} products selected (all ${scope}, minus ${excludedCount} excluded)`
        : `All ${matching} products ${scope} selected`
    : selectedCount > 0
      ? `${selectedCount.toLocaleString()} ${unit} selected`
      : "Nothing selected yet";

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center" gap="400">
          <BlockStack gap="100">
            <Text as="h2" variant="headingSm">
              {headline}
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              {matching} products {scope}
              {variantView
                ? ` · ${page.variantsOnPage} variants on this page`
                : ""}
              .
            </Text>
          </BlockStack>
          <ButtonGroup>
            <Button onClick={onSelectPage} disabled={page.rowIds.length === 0}>
              Select this page
            </Button>
            <Button
              variant="primary"
              onClick={onSelectAllMatching}
              disabled={
                (isSelectAll && excludedCount === 0) || page.rowIds.length === 0
              }
            >
              Select all {matching} matching
            </Button>
            {selectedCount > 0 || isSelectAll ? (
              <Button variant="tertiary" onClick={onClear}>
                Clear
              </Button>
            ) : null}
          </ButtonGroup>
        </InlineStack>

        {isSelectAll ? (
          <Banner tone="info">
            <p>
              The edit will run against every product {scope} at the moment you
              apply it — not just the rows loaded here. Uncheck individual rows
              to exclude them.
            </p>
          </Banner>
        ) : null}
      </BlockStack>
    </Card>
  );
}

// --- actions builder --------------------------------------------------------

function ActionsBuilder({
  actions,
  onAdd,
  onUpdate,
  onRemove,
}: {
  actions: EditAction[];
  onAdd: (type: EditAction["type"]) => void;
  onUpdate: (index: number, action: EditAction) => void;
  onRemove: (index: number) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center" gap="400">
          <BlockStack gap="100">
            <Text as="h2" variant="headingSm">
              Edit actions
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Stack as many as you need — they apply in order, as one job.
            </Text>
          </BlockStack>
          <Popover
            active={menuOpen}
            onClose={() => setMenuOpen(false)}
            activator={
              <Button
                icon={PlusIcon}
                disclosure
                onClick={() => setMenuOpen((open) => !open)}
              >
                Add action
              </Button>
            }
          >
            <ActionList
              actionRole="menuitem"
              items={ACTION_TYPES.map(({ type, label }) => ({
                content: label,
                onAction: () => {
                  onAdd(type);
                  setMenuOpen(false);
                },
              }))}
            />
          </Popover>
        </InlineStack>

        {actions.length === 0 ? (
          <Box
            padding="400"
            background="bg-surface-secondary"
            borderRadius="200"
          >
            <Text as="p" variant="bodyMd" tone="subdued" alignment="center">
              No actions yet. Add a price, tag, or status change to see exactly
              what it would do.
            </Text>
          </Box>
        ) : (
          <BlockStack gap="300">
            {actions.map((action, index) => (
              <ActionEditor
                key={`${index}-${action.type}`}
                action={action}
                onChange={(next) => onUpdate(index, next)}
                onRemove={() => onRemove(index)}
              />
            ))}
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}

function ActionEditor({
  action,
  onChange,
  onRemove,
}: {
  action: EditAction;
  onChange: (action: EditAction) => void;
  onRemove: () => void;
}) {
  return (
    <Box
      padding="300"
      borderWidth="025"
      borderColor="border"
      borderRadius="200"
    >
      <InlineStack align="space-between" blockAlign="start" gap="400" wrap>
        {action.type === "price" ? (
          <PriceFields action={action} onChange={onChange} />
        ) : action.type === "tags" ? (
          <TagFields action={action} onChange={onChange} />
        ) : (
          <StatusFields action={action} onChange={onChange} />
        )}
        <Box paddingBlockStart="500">
          <Button variant="tertiary" tone="critical" onClick={onRemove}>
            Remove
          </Button>
        </Box>
      </InlineStack>
    </Box>
  );
}

function PriceFields({
  action,
  onChange,
}: {
  action: Extract<EditAction, { type: "price" }>;
  onChange: (action: EditAction) => void;
}) {
  const byPercent = action.unit === "percent" && action.op !== "set";
  return (
    <InlineStack gap="300" blockAlign="end" wrap>
      <Select
        label="Field"
        options={[
          { label: "Price", value: "price" },
          { label: "Compare at price", value: "compareAtPrice" },
        ]}
        value={action.field}
        onChange={(field) =>
          onChange({ ...action, field: field as typeof action.field })
        }
      />
      <Select
        label="Change"
        options={[
          { label: "Decrease by", value: "decrease" },
          { label: "Increase by", value: "increase" },
          { label: "Set to", value: "set" },
        ]}
        value={action.op}
        onChange={(op) => onChange({ ...action, op: op as typeof action.op })}
      />
      <Box maxWidth="120px">
        <TextField
          label="Amount"
          type="number"
          min={0}
          value={action.amount}
          onChange={(amount) => onChange({ ...action, amount })}
          prefix={byPercent ? undefined : "$"}
          suffix={byPercent ? "%" : undefined}
          autoComplete="off"
        />
      </Box>
      {action.op === "set" ? null : (
        <Select
          label="Unit"
          options={[
            { label: "Percent", value: "percent" },
            { label: "Amount", value: "fixed" },
          ]}
          value={action.unit}
          onChange={(unit) =>
            onChange({ ...action, unit: unit as typeof action.unit })
          }
        />
      )}
      <Select
        label="Round to"
        options={[
          { label: "Don't round", value: "none" },
          { label: "….99", value: "end99" },
          { label: "….95", value: "end95" },
          { label: "Whole number", value: "end00" },
        ]}
        value={action.rounding}
        onChange={(rounding) =>
          onChange({ ...action, rounding: rounding as typeof action.rounding })
        }
      />
    </InlineStack>
  );
}

/**
 * Tags are entered one at a time rather than as a comma-separated string. A
 * single text field would have to re-parse on every keystroke, which eats the
 * separator the merchant just typed.
 */
function TagFields({
  action,
  onChange,
}: {
  action: Extract<EditAction, { type: "tags" }>;
  onChange: (action: EditAction) => void;
}) {
  const [input, setInput] = useState("");

  const commit = useCallback(() => {
    const tag = input.trim();
    if (!tag) return;
    const exists = action.tags.some(
      (existing) => existing.toLowerCase() === tag.toLowerCase(),
    );
    if (!exists) onChange({ ...action, tags: [...action.tags, tag] });
    setInput("");
  }, [action, input, onChange]);

  return (
    <BlockStack gap="200">
      <InlineStack gap="300" blockAlign="end" wrap>
        <Select
          label="Tags"
          options={[
            { label: "Add", value: "add" },
            { label: "Remove", value: "remove" },
            { label: "Replace all with", value: "replace" },
          ]}
          value={action.op}
          onChange={(op) => onChange({ ...action, op: op as typeof action.op })}
        />
        <TextField
          label="Tag"
          value={input}
          onChange={setInput}
          onBlur={commit}
          placeholder="Type a tag, press Enter"
          autoComplete="off"
        />
        <Button onClick={commit} disabled={!input.trim()}>
          Add tag
        </Button>
      </InlineStack>
      {action.tags.length ? (
        <InlineStack gap="200" wrap>
          {action.tags.map((tag) => (
            <Tag
              key={tag}
              onRemove={() =>
                onChange({
                  ...action,
                  tags: action.tags.filter((existing) => existing !== tag),
                })
              }
            >
              {tag}
            </Tag>
          ))}
        </InlineStack>
      ) : action.op === "replace" ? (
        <Text as="p" variant="bodySm" tone="subdued">
          No tags listed — this will clear every tag on the selected products.
        </Text>
      ) : null}
    </BlockStack>
  );
}

function StatusFields({
  action,
  onChange,
}: {
  action: Extract<EditAction, { type: "status" }>;
  onChange: (action: EditAction) => void;
}) {
  return (
    <Select
      label="Set status to"
      options={PRODUCT_STATUSES.map((status) => ({
        label: status.charAt(0) + status.slice(1).toLowerCase(),
        value: status,
      }))}
      value={action.value}
      onChange={(value) =>
        onChange({ ...action, value: value as ProductStatus })
      }
    />
  );
}

// --- preview ----------------------------------------------------------------

function PreviewSection({
  preview,
  previewing,
  canPreview,
  stale,
  selectionEmpty,
  hasActions,
  excluded,
  onExcludedChange,
  onRun,
}: {
  preview: PreviewResult | null;
  previewing: boolean;
  canPreview: boolean;
  stale: boolean;
  selectionEmpty: boolean;
  hasActions: boolean;
  excluded: string[];
  onExcludedChange: (excluded: string[]) => void;
  onRun: () => void;
}) {
  const excludedSet = useMemo(() => new Set(excluded), [excluded]);
  const rows = useMemo(() => preview?.rows ?? [], [preview]);

  const setMany = useCallback(
    (ids: string[], including: boolean) => {
      const next = new Set(excludedSet);
      for (const id of ids) {
        if (including) next.delete(id);
        else next.add(id);
      }
      onExcludedChange([...next]);
    },
    [excludedSet, onExcludedChange],
  );

  const handleSelectionChange = useCallback(
    (
      selectionType: IndexTableSelectionType,
      isSelecting: boolean,
      selectionId?: string | [number, number],
    ) => {
      switch (selectionType) {
        case IndexTableSelectionType.All:
        case IndexTableSelectionType.Page:
          setMany(
            rows.map((row) => row.id),
            isSelecting,
          );
          return;
        case IndexTableSelectionType.Multi:
        case IndexTableSelectionType.Range: {
          if (!Array.isArray(selectionId)) return;
          const [start, end] = selectionId;
          setMany(
            rows.slice(start, end + 1).map((row) => row.id),
            isSelecting,
          );
          return;
        }
        case IndexTableSelectionType.Single:
          if (typeof selectionId === "string") {
            setMany([selectionId], isSelecting);
          }
      }
    },
    [rows, setMany],
  );

  const helper = selectionEmpty
    ? "Select some products above first."
    : !hasActions
      ? "Add at least one edit action above."
      : null;

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center" gap="400">
          <BlockStack gap="100">
            <Text as="h2" variant="headingSm">
              Preview
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              {helper ??
                "Every before → after value, computed on the server. Nothing is written until you apply."}
            </Text>
          </BlockStack>
          <Button
            variant="primary"
            onClick={onRun}
            disabled={!canPreview || previewing}
            loading={previewing}
          >
            {preview ? "Refresh preview" : "Preview changes"}
          </Button>
        </InlineStack>

        {stale && !previewing ? (
          <Banner tone="warning">
            <p>
              The selection or actions changed since this preview was generated.
              Run it again to see the current diff.
            </p>
          </Banner>
        ) : null}

        {preview ? (
          <PreviewBody
            preview={preview}
            rows={rows}
            excludedSet={excludedSet}
            onSelectionChange={handleSelectionChange}
          />
        ) : null}
      </BlockStack>
    </Card>
  );
}

function PreviewBody({
  preview,
  rows,
  excludedSet,
  onSelectionChange,
}: {
  preview: PreviewResult;
  rows: PreviewRow[];
  excludedSet: Set<string>;
  onSelectionChange: (
    selectionType: IndexTableSelectionType,
    isSelecting: boolean,
    selectionId?: string | [number, number],
  ) => void;
}) {
  const included = rows.filter((row) => !excludedSet.has(row.id));
  // The same arithmetic the Apply modal quotes, so the two can never disagree.
  const { products, variants } = includedSummary(preview, excludedSet);

  if (preview.totalRows === 0) {
    return (
      <Banner tone="info" title="Nothing would change">
        <p>
          These actions leave every selected product exactly as it is
          {preview.productsUnchanged > 0
            ? ` — all ${preview.productsUnchanged.toLocaleString()} of them`
            : ""}
          . Adjust the actions and preview again.
        </p>
      </Banner>
    );
  }

  return (
    <BlockStack gap="300">
      <Banner tone="info">
        <p>
          <strong>
            {products.toLocaleString()} {products === 1 ? "product" : "products"}{" "}
            · {variants.toLocaleString()}{" "}
            {variants === 1 ? "variant" : "variants"} will change
          </strong>
          {excludedSet.size
            ? ` · ${excludedSet.size.toLocaleString()} excluded`
            : ""}
          {preview.productsUnchanged
            ? ` · ${preview.productsUnchanged.toLocaleString()} selected products already match`
            : ""}
          .
        </p>
      </Banner>

      {preview.truncated ? (
        <Banner tone="warning">
          <p>
            The selection is larger than one preview covers, so this diff stops
            at the first {PREVIEW_PRODUCT_CAP.toLocaleString()} products
            scanned. Narrow the filter to review the rest.
          </p>
        </Banner>
      ) : null}

      {preview.rowsTruncated ? (
        <Banner tone="warning">
          <p>
            Showing the first {rows.length.toLocaleString()} of{" "}
            {preview.totalRows.toLocaleString()} changed rows. Excluding rows
            here only affects the ones shown.
          </p>
        </Banner>
      ) : null}

      {preview.clippedProducts ? (
        <Banner tone="warning">
          <p>
            {preview.clippedProducts.toLocaleString()} selected{" "}
            {preview.clippedProducts === 1 ? "product has" : "products have"}{" "}
            more variants than a single preview query returns, so not every
            variant is listed below.
          </p>
        </Banner>
      ) : null}

      <IndexTable
        resourceName={{ singular: "change", plural: "changes" }}
        itemCount={rows.length}
        selectedItemsCount={
          included.length === rows.length ? "All" : included.length
        }
        onSelectionChange={onSelectionChange}
        headings={[
          { title: "Row" },
          { title: "Field" },
          { title: "Before", alignment: "end" },
          { title: "After", alignment: "end" },
        ]}
      >
        {rows.map((row, index) => (
          <IndexTable.Row
            id={row.id}
            key={row.id}
            position={index}
            selected={!excludedSet.has(row.id)}
          >
            <IndexTable.Cell>
              <BlockStack gap="050">
                <Text as="span" variant="bodyMd" fontWeight="semibold">
                  {row.productTitle}
                </Text>
                <Text as="span" variant="bodySm" tone="subdued">
                  {row.kind === "variant"
                    ? [row.variantTitle, row.sku].filter(Boolean).join(" · ")
                    : "Product"}
                </Text>
              </BlockStack>
            </IndexTable.Cell>
            <IndexTable.Cell>
              <BlockStack gap="050">
                {row.diffs.map((diff) => (
                  <Text as="span" key={diff.fieldPath} variant="bodySm">
                    {diff.label}
                  </Text>
                ))}
              </BlockStack>
            </IndexTable.Cell>
            <IndexTable.Cell>
              <BlockStack gap="050" inlineAlign="end">
                {row.diffs.map((diff) => (
                  <Text
                    as="span"
                    key={diff.fieldPath}
                    variant="bodySm"
                    tone="subdued"
                    textDecorationLine="line-through"
                  >
                    {diff.before}
                  </Text>
                ))}
              </BlockStack>
            </IndexTable.Cell>
            <IndexTable.Cell>
              <BlockStack gap="050" inlineAlign="end">
                {row.diffs.map((diff) => (
                  <Text
                    as="span"
                    key={diff.fieldPath}
                    variant="bodySm"
                    fontWeight="semibold"
                  >
                    {diff.after}
                  </Text>
                ))}
              </BlockStack>
            </IndexTable.Cell>
          </IndexTable.Row>
        ))}
      </IndexTable>
    </BlockStack>
  );
}

// --- filter descriptors -----------------------------------------------------

function buildFilterDescriptors(
  filters: SelectFilters,
  facets: { collections: FacetOption[]; vendors: FacetOption[]; productTypes: FacetOption[]; tags: FacetOption[] },
  patch: (patch: Partial<SelectFilters>) => void,
) {
  return [
    {
      key: "collectionId",
      label: "Collection",
      filter: (
        <OptionPicker
          options={facets.collections}
          selected={filters.collectionId ? [filters.collectionId] : []}
          placeholder="Search collections"
          onChange={(selected) => patch({ collectionId: selected[0] ?? "" })}
        />
      ),
      shortcut: true,
    },
    {
      key: "statuses",
      label: "Status",
      filter: (
        <ChoiceList
          title="Status"
          titleHidden
          allowMultiple
          choices={PRODUCT_STATUSES.map((status) => ({
            label: status.charAt(0) + status.slice(1).toLowerCase(),
            value: status,
          }))}
          selected={filters.statuses}
          onChange={(selected) =>
            patch({ statuses: selected as ProductStatus[] })
          }
        />
      ),
      shortcut: true,
    },
    {
      key: "vendors",
      label: "Vendor",
      filter: (
        <OptionPicker
          allowMultiple
          options={facets.vendors}
          selected={filters.vendors}
          placeholder="Search vendors"
          onChange={(vendors) => patch({ vendors })}
        />
      ),
      shortcut: true,
    },
    {
      key: "tags",
      label: "Tagged with",
      filter: (
        <OptionPicker
          allowMultiple
          options={facets.tags}
          selected={filters.tags}
          placeholder="Search tags"
          onChange={(tags) => patch({ tags })}
        />
      ),
      shortcut: true,
    },
    {
      key: "priceRange",
      label: "Price",
      filter: (
        <NumberRange
          minValue={filters.priceMin}
          maxValue={filters.priceMax}
          onChange={(priceMin, priceMax) => patch({ priceMin, priceMax })}
        />
      ),
      shortcut: true,
    },
    {
      key: "productTypes",
      label: "Product type",
      filter: (
        <OptionPicker
          allowMultiple
          options={facets.productTypes}
          selected={filters.productTypes}
          placeholder="Search product types"
          onChange={(productTypes) => patch({ productTypes })}
        />
      ),
    },
    {
      key: "inventoryRange",
      label: "Inventory",
      filter: (
        <NumberRange
          minValue={filters.inventoryMin}
          maxValue={filters.inventoryMax}
          onChange={(inventoryMin, inventoryMax) =>
            patch({ inventoryMin, inventoryMax })
          }
        />
      ),
    },
    {
      key: "skuPrefix",
      label: "SKU starts with",
      filter: (
        <TextField
          label="SKU starts with"
          labelHidden
          value={filters.skuPrefix}
          onChange={(skuPrefix) => patch({ skuPrefix })}
          autoComplete="off"
        />
      ),
    },
  ];
}

function buildAppliedFilters(
  filters: SelectFilters,
  facets: { collections: FacetOption[] },
  patch: (patch: Partial<SelectFilters>) => void,
) {
  const applied: { key: string; label: string; onRemove: () => void }[] = [];

  if (filters.collectionId) {
    const match = facets.collections.find(
      (option) => option.value === filters.collectionId,
    );
    applied.push({
      key: "collectionId",
      label: `Collection: ${match?.label ?? filters.collectionId}`,
      onRemove: () => patch({ collectionId: "" }),
    });
  }
  if (filters.statuses.length) {
    applied.push({
      key: "statuses",
      label: `Status: ${filters.statuses.join(", ").toLowerCase()}`,
      onRemove: () => patch({ statuses: [] }),
    });
  }
  if (filters.vendors.length) {
    applied.push({
      key: "vendors",
      label: `Vendor: ${filters.vendors.join(", ")}`,
      onRemove: () => patch({ vendors: [] }),
    });
  }
  if (filters.tags.length) {
    applied.push({
      key: "tags",
      label: `Tagged: ${filters.tags.join(", ")}`,
      onRemove: () => patch({ tags: [] }),
    });
  }
  if (filters.productTypes.length) {
    applied.push({
      key: "productTypes",
      label: `Type: ${filters.productTypes.join(", ")}`,
      onRemove: () => patch({ productTypes: [] }),
    });
  }
  if (filters.priceMin || filters.priceMax) {
    applied.push({
      key: "priceRange",
      label: `Price ${rangeLabel(filters.priceMin, filters.priceMax)}`,
      onRemove: () => patch({ priceMin: "", priceMax: "" }),
    });
  }
  if (filters.inventoryMin || filters.inventoryMax) {
    applied.push({
      key: "inventoryRange",
      label: `Inventory ${rangeLabel(filters.inventoryMin, filters.inventoryMax)}`,
      onRemove: () => patch({ inventoryMin: "", inventoryMax: "" }),
    });
  }
  if (filters.skuPrefix) {
    applied.push({
      key: "skuPrefix",
      label: `SKU starts with ${filters.skuPrefix}`,
      onRemove: () => patch({ skuPrefix: "" }),
    });
  }

  return applied;
}

/** Autocomplete over a facet list — scales past what a ChoiceList can show. */
function OptionPicker({
  options,
  selected,
  onChange,
  placeholder,
  allowMultiple = false,
}: {
  options: FacetOption[];
  selected: string[];
  onChange: (selected: string[]) => void;
  placeholder: string;
  allowMultiple?: boolean;
}) {
  const [input, setInput] = useState("");

  const visible = useMemo(() => {
    const needle = input.trim().toLowerCase();
    const matches = needle
      ? options.filter((option) => option.label.toLowerCase().includes(needle))
      : options;
    return matches.slice(0, 100);
  }, [input, options]);

  if (options.length === 0) {
    return (
      <Box paddingBlock="200">
        <Text as="p" variant="bodySm" tone="subdued">
          Nothing to choose from yet.
        </Text>
      </Box>
    );
  }

  return (
    <Autocomplete
      allowMultiple={allowMultiple}
      options={visible}
      selected={selected}
      onSelect={(next) => {
        onChange(next);
        if (!allowMultiple) setInput("");
      }}
      textField={
        <Autocomplete.TextField
          label={placeholder}
          labelHidden
          value={input}
          onChange={setInput}
          placeholder={placeholder}
          autoComplete="off"
        />
      }
    />
  );
}

function NumberRange({
  minValue,
  maxValue,
  onChange,
}: {
  minValue: string;
  maxValue: string;
  onChange: (min: string, max: string) => void;
}) {
  return (
    <InlineStack gap="200" wrap={false}>
      <TextField
        label="From"
        type="number"
        min={0}
        value={minValue}
        onChange={(value) => onChange(value, maxValue)}
        autoComplete="off"
      />
      <TextField
        label="To"
        type="number"
        min={0}
        value={maxValue}
        onChange={(value) => onChange(minValue, value)}
        autoComplete="off"
      />
    </InlineStack>
  );
}

// --- formatting -------------------------------------------------------------

function sortChoices() {
  return SORT_OPTIONS.flatMap((option) => [
    {
      label: option.label,
      value: `${option.value} asc` as const,
      directionLabel: "Ascending",
    },
    {
      label: option.label,
      value: `${option.value} desc` as const,
      directionLabel: "Descending",
    },
  ]);
}

function rangeLabel(min: string, max: string) {
  if (min && max) return `${min}–${max}`;
  if (min) return `≥ ${min}`;
  return `≤ ${max}`;
}

function formatCount(count: number, isLowerBound: boolean) {
  return `${count.toLocaleString()}${isLowerBound ? "+" : ""}`;
}

function money(amount: string, currencyCode: string) {
  const value = Number.parseFloat(amount);
  if (Number.isNaN(value)) return amount;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currencyCode,
  }).format(value);
}

function priceRange(product: ProductRow) {
  const min = money(product.minPrice, product.currencyCode);
  if (product.minPrice === product.maxPrice) return min;
  return `${min} – ${money(product.maxPrice, product.currencyCode)}`;
}

/**
 * Variant totals across all pages aren't a single API call, so "select all
 * matching" in variant view is reported against the products it spans; this
 * scales the page's variants-per-product ratio only for the selected-count
 * readout, never for what actually gets edited.
 */
function estimateVariantTotal(page: {
  totalProducts: number;
  products: { id: string }[];
  variantsOnPage: number;
}) {
  if (page.products.length === 0) return 0;
  const perProduct = page.variantsOnPage / page.products.length;
  return Math.round(page.totalProducts * perProduct);
}

function selectAllSummary(
  page: { totalProducts: number; totalIsLowerBound: boolean },
  variantView: boolean,
) {
  const count = formatCount(page.totalProducts, page.totalIsLowerBound);
  return variantView
    ? `All variants of ${count} products matching this filter are selected`
    : `All ${count} products matching this filter are selected`;
}
