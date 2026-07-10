import { describe, it, expect } from 'vitest';
import { fetchAllPages } from './rebookManage';

/**
 * Regression for the "49 niet verstuurd" ghost: PostgREST silently caps a one-shot select at
 * ~1000 rows, so a 1500+-claim round lost the invited_at representative rows and the manage view
 * showed already-emailed players as un-invited. fetchAllPages must keep requesting .range() pages
 * until a short page and concatenate them all.
 */
describe('fetchAllPages', () => {
  const dataset = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i }));

  const pagedSource = (all: { id: number }[], capPerPage = 1000) => {
    const calls: Array<[number, number]> = [];
    const buildPage = (from: number, to: number) => {
      calls.push([from, to]);
      // PostgREST semantics: range(from, to) inclusive, server may cap page size.
      const page = all.slice(from, Math.min(to + 1, from + capPerPage));
      return Promise.resolve({ data: page, error: null });
    };
    return { buildPage, calls };
  };

  it('concatenates past the 1000-row cap (the 1512-claim round returns ALL rows)', async () => {
    const all = dataset(1512);
    const { buildPage, calls } = pagedSource(all);
    const { rows, error } = await fetchAllPages<{ id: number }>(buildPage);
    expect(error).toBeNull();
    expect(rows).toHaveLength(1512); // one-shot read returned 1000 and dropped 512 — this must not
    expect(rows[1511]).toEqual({ id: 1511 });
    expect(calls).toEqual([[0, 999], [1000, 1999]]); // stops after the short page
  });

  it('a short first page (normal small round) makes exactly one request', async () => {
    const { buildPage, calls } = pagedSource(dataset(108));
    const { rows } = await fetchAllPages<{ id: number }>(buildPage);
    expect(rows).toHaveLength(108);
    expect(calls).toHaveLength(1);
  });

  it('an exact-multiple total (2000) needs a trailing empty page and terminates', async () => {
    const { buildPage, calls } = pagedSource(dataset(2000));
    const { rows } = await fetchAllPages<{ id: number }>(buildPage);
    expect(rows).toHaveLength(2000);
    expect(calls).toHaveLength(3); // 1000 + 1000 + 0 (empty short page ends the loop)
  });

  it('surfaces a page error with the rows gathered so far (caller decides fallback)', async () => {
    const err = { code: '42703', message: 'column reminded_at does not exist' };
    const buildPage = (from: number) =>
      Promise.resolve(from === 0 ? { data: null, error: err } : { data: [], error: null });
    const { rows, error } = await fetchAllPages<{ id: number }>(buildPage);
    expect(rows).toHaveLength(0);
    expect(error).toEqual(err); // the 42703 fallback in getCycleRebookStatus keys off this
  });

  it('empty result set → one call, zero rows, no error', async () => {
    const { buildPage, calls } = pagedSource([]);
    const { rows, error } = await fetchAllPages<{ id: number }>(buildPage);
    expect(rows).toEqual([]);
    expect(error).toBeNull();
    expect(calls).toHaveLength(1);
  });
});
