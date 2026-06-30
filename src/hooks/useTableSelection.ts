import { useState } from 'react';

export interface TableSelection<T> {
  selectedIds: Set<string>;
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  toggleSelect: (id: string) => void;
  toggleSelectAllVisible: (visible: T[]) => void;
  /** Are ALL of the currently-visible rows selected? (drives the header checkbox state) */
  isAllVisibleSelected: (visible: T[]) => boolean;
  selectedRows: T[];
}

/**
 * Generic page-scoped row selection for any single-id table (`T extends { id: string }`). Owns the
 * `selectedIds` Set + toggle / select-all-visible mutations + the resolution of `selectedRows` against
 * the current page rows. Selection is page-scoped, so callers clear it on filter/page changes via the
 * returned `setSelectedIds` (the dependency array is caller-specific).
 *
 * `getKey` MUST match the `getRowKey` passed to {@link DataTable} (default `row.id`). Tables with a
 * synthetic identity (e.g. the players' `g_…`/`p_…` keys) pass the same builder to both so the row
 * checkboxes, the header "all selected" state and the toggles never key off different ids.
 *
 * Generalised from `useInvoiceListSelection` — TWO-LEVEL selection (group+player, e.g. AcademyRebookManage)
 * is intentionally out of scope; those tables keep their bespoke selection.
 */
export function useTableSelection<T extends { id: string }>(
  rows: T[],
  getKey: (row: T) => string = (row) => row.id,
): TableSelection<T> {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAllVisible = (visible: T[]) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = visible.length > 0 && visible.every((r) => next.has(getKey(r)));
      if (allSelected) visible.forEach((r) => next.delete(getKey(r)));
      else visible.forEach((r) => next.add(getKey(r)));
      return next;
    });
  };

  const isAllVisibleSelected = (visible: T[]) =>
    visible.length > 0 && visible.every((r) => selectedIds.has(getKey(r)));

  const selectedRows = rows.filter((r) => selectedIds.has(getKey(r)));

  return {
    selectedIds,
    setSelectedIds,
    toggleSelect,
    toggleSelectAllVisible,
    isAllVisibleSelected,
    selectedRows,
  };
}
