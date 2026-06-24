import { useEffect, useMemo, useState } from 'react';

export interface ColumnDescriptor<K extends string> {
  key: K;
  label: string;
  isDefault: boolean;
}

/**
 * Visible-column state + best-effort localStorage persistence for a player-list table, shared by the
 * trainer + academy player pages (which previously inlined this identically). Generic over the page's
 * `ColumnKey` union. `storageKey` null disables persistence (e.g. before the owner id is known).
 */
export function useVisibleColumns<K extends string>(
  allColumns: ColumnDescriptor<K>[],
  defaultColumns: K[],
  storageKey: string | null,
) {
  const [visibleColumns, setVisibleColumns] = useState<K[]>(defaultColumns);
  const validKeys = useMemo(() => new Set(allColumns.map((c) => c.key)), [allColumns]);

  // Hydrate from localStorage once the storageKey is known; ignore corrupt/unavailable storage.
  useEffect(() => {
    if (!storageKey) return;
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const parsed = JSON.parse(stored) as K[];
        const valid = parsed.filter((k) => validKeys.has(k));
        if (valid.length) setVisibleColumns(valid);
      }
    } catch {
      /* non-fatal: keep defaults */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  const toggleColumn = (key: K) => {
    setVisibleColumns((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      if (storageKey) {
        try {
          localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
          /* non-fatal: persisting column prefs is best-effort */
        }
      }
      return next;
    });
  };

  const isColVisible = (key: K) => visibleColumns.includes(key);

  return { visibleColumns, toggleColumn, isColVisible };
}
