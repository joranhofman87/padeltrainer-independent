import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useVisibleColumns, type ColumnDescriptor } from './useVisibleColumns';

// jsdom here has no origin-backed localStorage; inject a minimal in-memory one.
const store: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (k: string) => (k in store ? store[k] : null),
  setItem: (k: string, v: string) => {
    store[k] = v;
  },
  removeItem: (k: string) => {
    delete store[k];
  },
  clear: () => {
    Object.keys(store).forEach((k) => delete store[k]);
  },
  key: (i: number) => Object.keys(store)[i] ?? null,
  get length() {
    return Object.keys(store).length;
  },
});

type K = 'a' | 'b' | 'c';
const cols: ColumnDescriptor<K>[] = [
  { key: 'a', label: 'A', isDefault: true },
  { key: 'b', label: 'B', isDefault: true },
  { key: 'c', label: 'C', isDefault: false },
];
const defaults: K[] = ['a', 'b'];

beforeEach(() => localStorage.clear());

describe('useVisibleColumns', () => {
  it('starts with the default columns', () => {
    const { result } = renderHook(() => useVisibleColumns(cols, defaults, 'k'));
    expect(result.current.visibleColumns).toEqual(['a', 'b']);
    expect(result.current.isColVisible('a')).toBe(true);
    expect(result.current.isColVisible('c')).toBe(false);
  });

  it('toggles a column on (appended) and persists it', () => {
    const { result } = renderHook(() => useVisibleColumns(cols, defaults, 'k'));
    act(() => result.current.toggleColumn('c'));
    expect(result.current.visibleColumns).toEqual(['a', 'b', 'c']);
    expect(JSON.parse(localStorage.getItem('k')!)).toEqual(['a', 'b', 'c']);
  });

  it('toggles a column off', () => {
    const { result } = renderHook(() => useVisibleColumns(cols, defaults, 'k'));
    act(() => result.current.toggleColumn('a'));
    expect(result.current.visibleColumns).toEqual(['b']);
  });

  it('hydrates stored columns and drops keys no longer in the descriptor list', () => {
    localStorage.setItem('k', JSON.stringify(['b', 'gone', 'c']));
    const { result } = renderHook(() => useVisibleColumns(cols, defaults, 'k'));
    expect(result.current.visibleColumns).toEqual(['b', 'c']);
  });

  it('keeps defaults when the stored value is corrupt', () => {
    localStorage.setItem('k', 'not json');
    const { result } = renderHook(() => useVisibleColumns(cols, defaults, 'k'));
    expect(result.current.visibleColumns).toEqual(['a', 'b']);
  });

  it('does not persist when storageKey is null', () => {
    const { result } = renderHook(() => useVisibleColumns(cols, defaults, null));
    act(() => result.current.toggleColumn('c'));
    expect(result.current.visibleColumns).toEqual(['a', 'b', 'c']);
    expect(localStorage.length).toBe(0);
  });
});
