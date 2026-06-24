import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useInvoiceListSelection } from './useInvoiceListSelection';

type Row = { id: string; total: number };
const rows: Row[] = [
  { id: 'a', total: 10 },
  { id: 'b', total: 20 },
  { id: 'c', total: 30 },
];

describe('useInvoiceListSelection', () => {
  it('starts with an empty selection', () => {
    const { result } = renderHook(() => useInvoiceListSelection(rows));
    expect(result.current.selectedIds.size).toBe(0);
    expect(result.current.selectedInvoices).toEqual([]);
  });

  it('toggles a single row on and off', () => {
    const { result } = renderHook(() => useInvoiceListSelection(rows));
    act(() => result.current.toggleSelect('b'));
    expect([...result.current.selectedIds]).toEqual(['b']);
    expect(result.current.selectedInvoices).toEqual([{ id: 'b', total: 20 }]);
    act(() => result.current.toggleSelect('b'));
    expect(result.current.selectedIds.size).toBe(0);
  });

  it('selects all visible rows, then deselects them on a second toggle', () => {
    const { result } = renderHook(() => useInvoiceListSelection(rows));
    act(() => result.current.toggleSelectAllVisible(rows));
    expect([...result.current.selectedIds].sort()).toEqual(['a', 'b', 'c']);
    expect(result.current.selectedInvoices).toHaveLength(3);
    act(() => result.current.toggleSelectAllVisible(rows));
    expect(result.current.selectedIds.size).toBe(0);
  });

  it('select-all adds the missing rows when the selection is partial', () => {
    const { result } = renderHook(() => useInvoiceListSelection(rows));
    act(() => result.current.toggleSelect('a'));
    act(() => result.current.toggleSelectAllVisible(rows));
    expect([...result.current.selectedIds].sort()).toEqual(['a', 'b', 'c']);
  });

  it('clears the selection via the exposed setSelectedIds', () => {
    const { result } = renderHook(() => useInvoiceListSelection(rows));
    act(() => result.current.toggleSelectAllVisible(rows));
    act(() => result.current.setSelectedIds(new Set()));
    expect(result.current.selectedIds.size).toBe(0);
  });

  it('resolves selectedInvoices against the passed page rows only', () => {
    const { result, rerender } = renderHook(({ r }) => useInvoiceListSelection(r), {
      initialProps: { r: rows },
    });
    act(() => result.current.toggleSelect('c'));
    // Row 'c' falls off the current page → it is no longer a selected invoice.
    rerender({ r: [{ id: 'a', total: 10 }] });
    expect(result.current.selectedInvoices).toEqual([]);
  });
});
