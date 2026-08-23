import { useCallback, useMemo, useState } from "react";

/**
 * Selection that survives pagination.
 *
 * Two modes, because "select all 1,247 matching products" can't be an ID list
 * — those IDs live on pages we haven't fetched. In `all` mode we hold the
 * filter as the selection and track only what the merchant unchecks, which is
 * also the shape Phase 4 persists as `EditJob.filterJson`.
 */
export type Selection =
  | { mode: "some"; ids: string[] }
  | { mode: "all"; excluded: string[] };

const NOTHING: Selection = { mode: "some", ids: [] };

/**
 * Validates a selection that arrived over the wire. The preview endpoint is
 * driven by whatever the browser posts, so anything unrecognised collapses to
 * "nothing selected" rather than being trusted into a diff.
 */
export function coerceSelection(value: unknown): Selection {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const strings = (input: unknown) =>
      Array.isArray(input)
        ? input.filter((item): item is string => typeof item === "string")
        : [];
    if (record.mode === "all") {
      return { mode: "all", excluded: strings(record.excluded) };
    }
    if (record.mode === "some") {
      return { mode: "some", ids: strings(record.ids) };
    }
  }
  return NOTHING;
}

/** Identity of a selection — used to drop a preview that no longer describes it. */
export function selectionSignature(selection: Selection): string {
  return selection.mode === "all"
    ? `all:${[...selection.excluded].sort().join(",")}`
    : `some:${[...selection.ids].sort().join(",")}`;
}

export interface SelectionApi {
  selection: Selection;
  /** True once "select all matching filter" is on. */
  isSelectAll: boolean;
  isSelected(id: string): boolean;
  /** Selected rows across every page. Exact unless `total` is a lower bound. */
  count(total: number): number;
  toggle(id: string, selecting: boolean): void;
  setMany(ids: string[], selecting: boolean): void;
  selectAllMatching(): void;
  clear(): void;
  /** True when every row on the current page is selected. */
  pageFullySelected(pageIds: string[]): boolean;
}

/**
 * @param signature Identity of the current filter set. When it changes the
 * selection is dropped, since the previous IDs no longer describe the results.
 */
export function useSelection(signature: string): SelectionApi {
  const [state, setState] = useState({ signature, selection: NOTHING });

  // Reset during render rather than in an effect, so a filter change never
  // paints a stale count for a frame.
  if (state.signature !== signature) {
    setState({ signature, selection: NOTHING });
  }
  const selection =
    state.signature === signature ? state.selection : NOTHING;

  const update = useCallback(
    (next: (current: Selection) => Selection) => {
      setState((current) => ({
        signature,
        selection: next(current.signature === signature ? current.selection : NOTHING),
      }));
    },
    [signature],
  );

  const selectedSet = useMemo(
    () => new Set(selection.mode === "some" ? selection.ids : selection.excluded),
    [selection],
  );

  const isSelected = useCallback(
    (id: string) =>
      selection.mode === "all" ? !selectedSet.has(id) : selectedSet.has(id),
    [selection.mode, selectedSet],
  );

  const setMany = useCallback(
    (ids: string[], selecting: boolean) => {
      update((current) => {
        if (current.mode === "all") {
          // In select-all mode, checking a row clears its exclusion.
          const excluded = new Set(current.excluded);
          for (const id of ids) {
            if (selecting) excluded.delete(id);
            else excluded.add(id);
          }
          return { mode: "all", excluded: [...excluded] };
        }
        const next = new Set(current.ids);
        for (const id of ids) {
          if (selecting) next.add(id);
          else next.delete(id);
        }
        return { mode: "some", ids: [...next] };
      });
    },
    [update],
  );

  const toggle = useCallback(
    (id: string, selecting: boolean) => setMany([id], selecting),
    [setMany],
  );

  const selectAllMatching = useCallback(
    () => update(() => ({ mode: "all", excluded: [] })),
    [update],
  );

  const clear = useCallback(() => update(() => NOTHING), [update]);

  const count = useCallback(
    (total: number) =>
      selection.mode === "all"
        ? Math.max(0, total - selection.excluded.length)
        : selection.ids.length,
    [selection],
  );

  const pageFullySelected = useCallback(
    (pageIds: string[]) => pageIds.length > 0 && pageIds.every(isSelected),
    [isSelected],
  );

  return {
    selection,
    isSelectAll: selection.mode === "all",
    isSelected,
    count,
    toggle,
    setMany,
    selectAllMatching,
    clear,
    pageFullySelected,
  };
}
