/**
 * PostgREST caps every response at a fixed row count (default 1000). A plain
 * `.select()` over a set larger than that silently returns only the first page
 * — no error. On money paths (invoice re-sync after a price/split change) that
 * means invoices past the cap keep the OLD amount and nobody is told.
 *
 * These helpers assemble the FULL result set regardless of size by:
 *   - range-paging a single query until a short page comes back, and
 *   - chunking a large `.in(col, ids)` input so neither the URL nor the ANY()
 *     array grows unbounded — each chunk is itself range-paged.
 *
 * Every query passed in MUST carry a stable, unique `.order(...)` (e.g. by
 * primary key) so successive `.range()` windows don't skip or duplicate rows.
 */

/** PostgREST's default hard cap; keep our page size at or below it. */
export const SUPABASE_PAGE_SIZE = 1000;
/** Max ids per `.in(...)` chunk — bounded to keep the request URL/array small. */
export const SUPABASE_IN_CHUNK_SIZE = 200;

// Structurally: anything exposing PostgREST's `.range(from,to)` that awaits to a
// { data, error } envelope. Kept loose (the resolved data/error carry extra
// fields on the real supabase builder) so callers pass builders unchanged.
type Rangeable<T> = {
  range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>;
};

/**
 * Range-page a single ordered query until exhausted, returning every row.
 * `buildQuery` is called once per page and must return a fresh builder that
 * still accepts `.range(from, to)` (i.e. don't pre-apply `.range`/await it).
 */
export async function fetchAllRows<T>(
  buildQuery: () => Rangeable<T>,
  pageSize: number = SUPABASE_PAGE_SIZE,
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const to = from + pageSize - 1;
    const { data, error } = await buildQuery().range(from, to);
    if (error) {
      const message =
        typeof error === "object" && error !== null && "message" in error
          ? String((error as { message: unknown }).message)
          : String(error);
      throw new Error(message);
    }
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < pageSize) break; // short page → last page
    from += pageSize;
  }
  return all;
}

/** Split an array into consecutive chunks of at most `size`. */
export function chunk<T>(items: T[], size: number = SUPABASE_IN_CHUNK_SIZE): T[][] {
  if (size <= 0) throw new Error("chunk size must be positive");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Fetch every row matching `.in(col, ids)` for an arbitrarily large `ids`
 * input: the ids are chunked (bounded request size) and each chunk's result is
 * itself range-paged, so neither a huge input nor a huge output is truncated.
 *
 * `buildQuery(idChunk)` must return a fresh builder with the `.in(col, idChunk)`
 * (and any other filters) applied plus a stable `.order(...)`, still accepting
 * `.range(...)`.
 */
export async function fetchAllByInChunks<T>(
  ids: string[],
  buildQuery: (idChunk: string[]) => Rangeable<T>,
  opts?: { chunkSize?: number; pageSize?: number },
): Promise<T[]> {
  const chunkSize = opts?.chunkSize ?? SUPABASE_IN_CHUNK_SIZE;
  const pageSize = opts?.pageSize ?? SUPABASE_PAGE_SIZE;
  const all: T[] = [];
  for (const idChunk of chunk(ids, chunkSize)) {
    const rows = await fetchAllRows<T>(() => buildQuery(idChunk), pageSize);
    all.push(...rows);
  }
  return all;
}
