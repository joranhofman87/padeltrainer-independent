import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fetchAllKeyset, fetchAllRows } from "./paginate.ts";

// A fake PostgREST page source: .range(from,to) inclusive, server caps a page at `cap` rows.
function pagedSource(all: Array<{ id: number }>, cap = 1000) {
  const calls: Array<[number, number]> = [];
  const fetchPage = (from: number, to: number) => {
    calls.push([from, to]);
    const page = all.slice(from, Math.min(to + 1, from + cap));
    return Promise.resolve({ data: page, error: null });
  };
  return { fetchPage, calls };
}

Deno.test("fetchAllRows concatenates past the 1000-row cap (1500 rows, NO truncation)", async () => {
  const all = Array.from({ length: 1500 }, (_, i) => ({ id: i }));
  const { fetchPage, calls } = pagedSource(all);
  const { rows, error } = await fetchAllRows<{ id: number }>(fetchPage);
  assertEquals(error, null);
  assertEquals(rows.length, 1500);
  assertEquals(rows[1499].id, 1499);
  assertEquals(calls, [[0, 999], [1000, 1999]]); // stops after the short page
});

Deno.test("fetchAllRows returns all 1001 rows (the +1 a single capped read would drop)", async () => {
  const all = Array.from({ length: 1001 }, (_, i) => ({ id: i }));
  const { fetchPage } = pagedSource(all);
  const { rows } = await fetchAllRows<{ id: number }>(fetchPage);
  assertEquals(rows.length, 1001);
});

Deno.test("fetchAllRows makes exactly one call for a short first page", async () => {
  const { fetchPage, calls } = pagedSource(Array.from({ length: 50 }, (_, i) => ({ id: i })));
  const { rows } = await fetchAllRows<{ id: number }>(fetchPage);
  assertEquals(rows.length, 50);
  assertEquals(calls.length, 1);
});

Deno.test("fetchAllRows surfaces a page error with the rows gathered so far", async () => {
  const fetchPage = (from: number) =>
    Promise.resolve(from === 0 ? { data: null, error: { message: "boom" } } : { data: [], error: null });
  const { rows, error } = await fetchAllRows<{ id: number }>(fetchPage);
  assertEquals(rows.length, 0);
  assertEquals(error?.message, "boom");
});

// ── fetchAllKeyset (Codex round-7 #7): stable over a MUTABLE result set ───────────────────────────

// A keyset source over a live set of numeric ids: fetchPage(after, limit) returns ids > after,
// ordered, up to `limit`. `onPage(n)` can mutate the set between pages (simulate a concurrent status
// change that removes a row).
function keysetSource(ids: number[], onPage?: (pageIndex: number) => void) {
  let page = 0;
  const live = new Set(ids);
  const fetchPage = (after: string | null, limit: number) => {
    onPage?.(page++); // mutate BEFORE computing this page (models a change that landed before the read)
    const afterN = after == null ? -Infinity : Number(after);
    const rows = [...live].filter((n) => n > afterN).sort((a, b) => a - b).slice(0, limit).map((n) => ({ id: String(n) }));
    return Promise.resolve({ data: rows, error: null });
  };
  return { fetchPage, live };
}

Deno.test("fetchAllKeyset concatenates all rows past the page size (no truncation)", async () => {
  const ids = Array.from({ length: 1500 }, (_, i) => i + 1);
  const { fetchPage } = keysetSource(ids);
  const { rows, error } = await fetchAllKeyset<{ id: string }>(fetchPage, (r) => r.id, 1000);
  assertEquals(error, null);
  assertEquals(rows.length, 1500);
});

Deno.test("fetchAllKeyset: removing an ALREADY-READ row between pages does NOT skip a later sibling (offset would)", async () => {
  // ids 1..12, page size 5. After page 1 (1..5) an already-read row (id 3) leaves the set. Keyset asks
  // for id > 5 next, so ids 6..12 are ALL still returned — whereas an offset read (offset 5) would now
  // point past id 6 (the set shifted) and skip it.
  const src = keysetSource(Array.from({ length: 12 }, (_, i) => i + 1), (pageIndex) => {
    if (pageIndex === 1) src.live.delete(3); // between page 0 and page 1
  });
  const { rows } = await fetchAllKeyset<{ id: string }>(src.fetchPage, (r) => r.id, 5);
  const got = rows.map((r) => Number(r.id)).sort((a, b) => a - b);
  // Every id from 6..12 is present (no skip); the already-read 3 is still in the gathered rows.
  for (let n = 6; n <= 12; n++) assertEquals(got.includes(n), true, `id ${n} must not be skipped`);
  assertEquals(got.includes(3), true);
});

Deno.test("fetchAllKeyset: a row entering the set after its keyset position is simply not seen (no crash, no dup)", async () => {
  const src = keysetSource([1, 2, 3, 4, 5], (pageIndex) => {
    if (pageIndex === 1) src.live.add(2.5 as unknown as number); // a low id appears after we've passed it
  });
  const { rows } = await fetchAllKeyset<{ id: string }>(src.fetchPage, (r) => r.id, 3);
  // 2.5 sorts below the last-read key (3) so it's never returned — but nothing is skipped or duplicated.
  const got = rows.map((r) => r.id);
  assertEquals(new Set(got).size, got.length); // no duplicates
});

Deno.test("fetchAllKeyset surfaces a page error", async () => {
  const fetchPage = (after: string | null) =>
    Promise.resolve(after == null ? { data: null, error: { message: "keyset boom" } } : { data: [], error: null });
  const { rows, error } = await fetchAllKeyset<{ id: string }>(fetchPage, (r) => r.id);
  assertEquals(rows.length, 0);
  assertEquals(error?.message, "keyset boom");
});

Deno.test("fetchAllKeyset FAILS CLOSED when the cursor does not advance (Codex round-8 #6)", async () => {
  // A FULL page whose last key never advances past the cursor (broken keyOf / non-unique key) would
  // otherwise loop or silently truncate — it must return an ERROR, not partial rows with error:null.
  const fetchPage = () => Promise.resolve({ data: [{ id: "x" }, { id: "x" }, { id: "x" }], error: null });
  const { error } = await fetchAllKeyset<{ id: string }>(fetchPage, (r) => r.id, 3);
  assertEquals(error !== null, true);
  assertEquals((error?.message ?? "").includes("did not advance"), true);
});
