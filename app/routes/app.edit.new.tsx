import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigation, useSearchParams } from "@remix-run/react";
import {
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
  Page,
  Text,
  TextField,
  Thumbnail,
  useSetIndexFiltersMode,
} from "@shopify/polaris";
import { ImageIcon } from "@shopify/polaris-icons";
import { TitleBar } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import { useSelection } from "../lib/use-selection";
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

export default function NewBulkEdit() {
  const { page, facets, filters, sort } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigation = useNavigation();
  const { mode, setMode } = useSetIndexFiltersMode();

  const loading = navigation.state === "loading";
  const variantView = filters.view === "variant";
  const selection = useSelectionForFilters(filters);

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
      subtitle="Step 1 of 3 — choose what to edit"
      primaryAction={{
        content: "Choose edit actions",
        disabled: true,
        helpText: "Available in the next step",
      }}
    >
      <TitleBar title="New bulk edit" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
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
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
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
