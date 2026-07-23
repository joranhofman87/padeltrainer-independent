// Bounded pagination for edge reads. PostgREST silently caps a single select at ~1000 rows (no
// error, just a truncated result), so any read whose result set can exceed 1000 must page with
// .range() until a short page. Mirrors the frontend rebookManage.fetchAllPages. Fail-loud: a page
// error stops immediately and is returned with the rows gathered so far (the caller decides).

export const PAGE_SIZE = 1000;

/**
 * Drive `fetchPage(from, to)` (inclusive .range bounds) until a short page, concatenating all rows.
 * Returns `{ rows, error }` — on a page error, returns the rows gathered so far plus the error so the
 * caller can throw. Guards against a non-terminating loop if a page ever over-returns.
 *
 * OFFSET-based: safe ONLY for an IMMUTABLE result set within the read. For a filtered set that can
 * change between pages (e.g. claims leaving status='pending' concurrently), a removed early row shifts
 * every later offset and SKIPS a row — use fetchAllKeyset instead (Codex round-7 #7).
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

/**
 * KEYSET pagination over a unique, IMMUTABLE key (Codex round-7 #7). Each page asks for rows with
 * key > the last key seen, ordered by that key — so a row leaving the filter (a claim that stops
 * being 'pending') between pages cannot shift an offset and skip a sibling: already-read rows are
 * fixed, and later pages simply won't include rows that no longer match. Stable for the mutable
 * pending-claim discovery reads.
 *
 * `fetchPage(afterKey, limit)` must apply `.gt(keyCol, afterKey)` when afterKey is non-null,
 * `.order(keyCol)`, and `.limit(limit)`. `keyOf` extracts the key from a row (a UUID/id string).
 */
export async function fetchAllKeyset<T>(
  fetchPage: (afterKey: string | null, limit: number) => PromiseLike<{ data: unknown; error: { message?: string } | null }>,
  keyOf: (row: T) => string,
  pageSize: number = PAGE_SIZE,
): Promise<{ rows: T[]; error: { message?: string } | null }> {
  const rows: T[] = [];
  let after: string | null = null;
  for (;;) {
    const { data, error } = await fetchPage(after, pageSize);
    if (error) return { rows, error };
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < pageSize) return { rows, error: null };
    const nextAfter = keyOf(page[page.length - 1]);
    // A FULL page whose last key did not advance past the cursor means a broken key extractor or a
    // non-unique/unordered key — continuing would loop forever, and returning the rows so far would be
    // plausible-but-INCOMPLETE data. Fail CLOSED (Codex round-8 #6): correctness-critical discovery
    // must surface an error, never silent partial data.
    if (nextAfter == null || nextAfter === after) {
      return { rows, error: { message: `keyset cursor did not advance past ${String(after)} — broken key extractor or non-unique key` } };
    }
    after = nextAfter;
  }
}
