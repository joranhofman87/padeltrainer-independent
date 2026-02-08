import { useState, useMemo, useCallback } from "react";

export type SortDirection = "asc" | "desc" | null;

export interface SortConfig<T> {
  key: keyof T | null;
  direction: SortDirection;
}

export function useTableSort<T>(data: T[], defaultSortKey?: keyof T, defaultDirection?: SortDirection) {
  const [sortConfig, setSortConfig] = useState<SortConfig<T>>({
    key: defaultSortKey ?? null,
    direction: defaultSortKey ? (defaultDirection ?? "asc") : null,
  });

  const handleSort = useCallback((key: keyof T) => {
    setSortConfig((prev) => {
      if (prev.key !== key) {
        return { key, direction: "asc" };
      }
      if (prev.direction === "asc") {
        return { key, direction: "desc" };
      }
      if (prev.direction === "desc") {
        return { key: null, direction: null };
      }
      return { key, direction: "asc" };
    });
  }, []);

  const sortedData = useMemo(() => {
    if (!sortConfig.key || !sortConfig.direction) {
      return data;
    }

    const sorted = [...data].sort((a, b) => {
      const aValue = a[sortConfig.key!];
      const bValue = b[sortConfig.key!];

      // Handle null/undefined
      if (aValue == null && bValue == null) return 0;
      if (aValue == null) return sortConfig.direction === "asc" ? 1 : -1;
      if (bValue == null) return sortConfig.direction === "asc" ? -1 : 1;

      // Handle nested objects (for things like profile.full_name)
      let compareA = aValue;
      let compareB = bValue;

      // Handle dates
      if (typeof compareA === "string" && typeof compareB === "string") {
        const dateA = Date.parse(compareA);
        const dateB = Date.parse(compareB);
        if (!isNaN(dateA) && !isNaN(dateB)) {
          return sortConfig.direction === "asc" ? dateA - dateB : dateB - dateA;
        }
      }

      // Handle numbers
      if (typeof compareA === "number" && typeof compareB === "number") {
        return sortConfig.direction === "asc" 
          ? compareA - compareB 
          : compareB - compareA;
      }

      // Handle booleans
      if (typeof compareA === "boolean" && typeof compareB === "boolean") {
        return sortConfig.direction === "asc"
          ? (compareA === compareB ? 0 : compareA ? -1 : 1)
          : (compareA === compareB ? 0 : compareA ? 1 : -1);
      }

      // Handle strings
      const stringA = String(compareA).toLowerCase();
      const stringB = String(compareB).toLowerCase();
      
      return sortConfig.direction === "asc"
        ? stringA.localeCompare(stringB)
        : stringB.localeCompare(stringA);
    });

    return sorted;
  }, [data, sortConfig]);

  return {
    sortedData,
    sortConfig,
    handleSort,
    setSortConfig,
  };
}
