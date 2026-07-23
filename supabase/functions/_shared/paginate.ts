// Bounded pagination for edge reads. PostgREST silently caps a single select at ~1000 rows (no
// error, just a truncated result), so any read whose result set can exceed 1000 must page with
// .range() until a short page. Mirrors the frontend rebookManage.fetchAllPages. Fail-loud: a page
// error stops immediately and is returned with the rows gathered so far (the caller decides).

export const PAGE_SIZE = 1000;

/**
 * Drive `fetchPage(from, to)` (inclusive .range bounds) until a short page, concatenating all rows.
 * Returns `{ rows, error }` — on a page error, returns the rows gathered so far plus the error so the
 * caller can throw. Guards against a non-terminating loop if a page ever over-returns.
 */
export async function fetchAllRows<T>(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message?: string } | null }>,
  pageSize: number = PAGE_SIZE,
): Promise<{ rows: T[]; error: { message?: string } | null }> {
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await fetchPage(from, from + pageSize - 1);
    if (error) return { rows, error };
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < pageSize) return { rows, error: null };
  }
}
