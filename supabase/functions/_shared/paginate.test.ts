import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fetchAllRows } from "./paginate.ts";

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
