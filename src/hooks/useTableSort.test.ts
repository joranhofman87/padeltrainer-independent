import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTableSort } from "./useTableSort";

type Row = { id: number; name: string | null | undefined; score: number | null };

const rows: Row[] = [
  { id: 1, name: "banana", score: 2 },
  { id: 2, name: null, score: null },
  { id: 3, name: "apple", score: 3 },
  { id: 4, name: undefined, score: 1 },
];

const names = (data: Row[]) => data.map((r) => r.name);
const ids = (data: Row[]) => data.map((r) => r.id);

describe("useTableSort — default mode (no options)", () => {
  it("places null/undefined LAST on asc (existing behavior)", () => {
    const { result } = renderHook(() => useTableSort(rows));
    act(() => result.current.handleSort("name"));
    expect(result.current.sortConfig).toEqual({ key: "name", direction: "asc" });
    expect(names(result.current.sortedData)).toEqual(["apple", "banana", null, undefined]);
  });

  it("places null/undefined FIRST on desc (existing behavior, documented so emptyLast cannot regress it)", () => {
    const { result } = renderHook(() => useTableSort(rows));
    act(() => result.current.handleSort("name"));
    act(() => result.current.handleSort("name"));
    expect(result.current.sortConfig).toEqual({ key: "name", direction: "desc" });
    expect(names(result.current.sortedData)).toEqual([null, undefined, "banana", "apple"]);
  });

  it("keeps empty strings in the normal comparison (not treated as empty)", () => {
    const data: Row[] = [
      { id: 1, name: "banana", score: null },
      { id: 2, name: "", score: null },
    ];
    const { result } = renderHook(() => useTableSort(data));
    act(() => result.current.handleSort("name"));
    // "" localeCompares before "banana" — default mode does NOT push it last
    expect(names(result.current.sortedData)).toEqual(["", "banana"]);
  });
});

describe("useTableSort — emptyLast mode", () => {
  const withEmpties: Row[] = [
    { id: 1, name: "banana", score: 2 },
    { id: 2, name: null, score: null },
    { id: 3, name: "", score: 3 },
    { id: 4, name: "apple", score: null },
    { id: 5, name: undefined, score: 1 },
  ];

  it("sorts null/undefined/empty-string LAST on asc", () => {
    const { result } = renderHook(() =>
      useTableSort(withEmpties, undefined, undefined, { emptyLast: true }),
    );
    act(() => result.current.handleSort("name"));
    expect(names(result.current.sortedData).slice(0, 2)).toEqual(["apple", "banana"]);
    expect(names(result.current.sortedData).slice(2)).toEqual(expect.arrayContaining([null, "", undefined]));
    result.current.sortedData.slice(2).forEach((r) => {
      expect(r.name == null || r.name === "").toBe(true);
    });
  });

  it("sorts null/undefined/empty-string LAST on desc too", () => {
    const { result } = renderHook(() =>
      useTableSort(withEmpties, undefined, undefined, { emptyLast: true }),
    );
    act(() => result.current.handleSort("name"));
    act(() => result.current.handleSort("name"));
    expect(result.current.sortConfig.direction).toBe("desc");
    expect(names(result.current.sortedData).slice(0, 2)).toEqual(["banana", "apple"]);
    result.current.sortedData.slice(2).forEach((r) => {
      expect(r.name == null || r.name === "").toBe(true);
    });
  });

  it("sorts numeric columns normally with nulls last in both directions", () => {
    const { result } = renderHook(() =>
      useTableSort(withEmpties, undefined, undefined, { emptyLast: true }),
    );
    act(() => result.current.handleSort("score"));
    expect(ids(result.current.sortedData).slice(0, 3)).toEqual([5, 1, 3]); // 1, 2, 3
    act(() => result.current.handleSort("score"));
    expect(ids(result.current.sortedData).slice(0, 3)).toEqual([3, 1, 5]); // 3, 2, 1
    // nulls trail in both directions
    result.current.sortedData.slice(3).forEach((r) => expect(r.score).toBeNull());
  });
});

describe("useTableSort — toggle cycle", () => {
  it("cycles asc -> desc -> cleared (original order)", () => {
    const { result } = renderHook(() => useTableSort(rows, undefined, undefined, { emptyLast: true }));
    expect(result.current.sortConfig).toEqual({ key: null, direction: null });

    act(() => result.current.handleSort("name"));
    expect(result.current.sortConfig).toEqual({ key: "name", direction: "asc" });

    act(() => result.current.handleSort("name"));
    expect(result.current.sortConfig).toEqual({ key: "name", direction: "desc" });

    act(() => result.current.handleSort("name"));
    expect(result.current.sortConfig).toEqual({ key: null, direction: null });
    expect(ids(result.current.sortedData)).toEqual([1, 2, 3, 4]); // untouched input order
  });
});
