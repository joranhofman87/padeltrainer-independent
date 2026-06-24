import { useEffect } from 'react';
import { useTableSort } from '@/hooks/useTableSort';

/**
 * The invoice list tables sort on five header columns that map to server-side sort keys.
 * `_computedStatus` is a SYNTHETIC header key (no such row field) that maps to the RPC 'status'
 * sort — typing the sort state against this shape lets the pages reference those keys without casts.
 */
type InvoiceSortColumns = {
  player_name: unknown;
  total: unknown;
  due_date: unknown;
  paid_at: unknown;
  _computedStatus: unknown;
};

/** Header sort column → RPC `sort` param. Extracted verbatim from both invoice list pages. */
export function mapInvoiceSortKeyToRpc(key: keyof InvoiceSortColumns | null): string {
  switch (key) {
    case 'player_name':
      return 'player_name';
    case 'total':
      return 'total';
    case 'due_date':
      return 'due_date';
    case '_computedStatus':
      return 'status';
    case 'paid_at':
      return 'paid_at';
    default:
      return 'created_at';
  }
}

/**
 * Shared header-sort wiring for the trainer + academy invoice LIST pages. Owns the (display-only)
 * `useTableSort` affordance, the paid-tab default-sort effect, and the header-key → RPC param
 * mapping. The visible rows come from the server page, so this sorts nothing locally; it only
 * produces the `sort` / `sortDir` the RPC is called with. Behaviour is preserved verbatim.
 */
export function useInvoiceListSort(activeTab: string) {
  const { sortConfig, handleSort, setSortConfig } = useTableSort<InvoiceSortColumns>([]);

  // Paid tab defaults to paid_at desc; every other tab clears the column so the RPC falls back to
  // created_at desc. (Byte-identical effect in both pages before extraction.)
  useEffect(() => {
    if (activeTab === 'paid') {
      setSortConfig({ key: 'paid_at', direction: 'desc' });
    } else {
      setSortConfig({ key: null, direction: null });
    }
  }, [activeTab, setSortConfig]);

  const sort = mapInvoiceSortKeyToRpc(sortConfig.key);
  const sortDir: 'asc' | 'desc' = sortConfig.direction === 'asc' ? 'asc' : 'desc';

  return { sortConfig, handleSort, sort, sortDir };
}
