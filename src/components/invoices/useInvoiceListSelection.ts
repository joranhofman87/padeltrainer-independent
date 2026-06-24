import { useState } from 'react';

/**
 * Shared page-scoped row selection for the trainer + academy invoice LIST pages. Owns the
 * `selectedIds` Set, the toggle / select-all-visible mutations, and the `selectedInvoices`
 * resolution against the current page rows — all extracted byte-identically from both pages.
 *
 * The clear-on-filter-change effect stays in each page (its dependency array is page-specific:
 * academy clears on trainer/location filter changes too), driven through the returned `setSelectedIds`.
 */
export function useInvoiceListSelection<T extends { id: string }>(rows: T[]) {
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
      const allSelected = visible.length > 0 && visible.every((i) => next.has(i.id));
      if (allSelected) visible.forEach((i) => next.delete(i.id));
      else visible.forEach((i) => next.add(i.id));
      return next;
    });
  };

  // Selection is page-scoped, so resolve against the visible page rows.
  const selectedInvoices = rows.filter((i) => selectedIds.has(i.id));

  return { selectedIds, setSelectedIds, toggleSelect, toggleSelectAllVisible, selectedInvoices };
}
