import { describe, it, expect } from 'vitest';
import {
  fetchAllRows,
  fetchAllByInChunks,
  chunk,
  SUPABASE_PAGE_SIZE,
  SUPABASE_IN_CHUNK_SIZE,
} from '@/lib/supabasePaging';

function makeSource(total: number, pageSize = SUPABASE_PAGE_SIZE) {
  const rows = Array.from({ length: total }, (_, i) => ({ id: `id-${i}` }));
  return {
    rows,
    build() {
      return {
        range(from: number, to: number) {
          const clampedTo = Math.min(to, from + pageSize - 1);
          const slice = rows.slice(from, clampedTo + 1);
          return Promise.resolve({ data: slice, error: null as null });
        },
      };
    },
  };
}

describe('supabasePaging.fetchAllRows', () => {
  it('assembles ALL rows when the set exceeds one PostgREST page (>1000)', async () => {
    const total = 2500;
    const src = makeSource(total);
    let pages = 0;
    const out = await fetchAllRows<{ id: string }>(() => {
      pages++;
      return src.build();
    });
    expect(out.length).toBe(total);
    expect(out[0].id).toBe('id-0');
    expect(out[total - 1].id).toBe(`id-${total - 1}`);
    expect(pages).toBe(3);
  });

  it('single-truncated-page control: one .range() call alone loses rows past the cap', async () => {
    const src = makeSource(2500);
    const { data } = await src.build().range(0, 100000);
    expect(data.length).toBe(SUPABASE_PAGE_SIZE);
  });

  it('a set that exactly fills one page still terminates', async () => {
    const src = makeSource(SUPABASE_PAGE_SIZE);
    const out = await fetchAllRows<{ id: string }>(() => src.build());
    expect(out.length).toBe(SUPABASE_PAGE_SIZE);
  });

  it('propagates errors instead of silently returning a partial set', async () => {
    await expect(
      fetchAllRows(() => ({
        range: () => Promise.resolve({ data: null, error: { message: 'boom' } }),
      })),
    ).rejects.toThrow('boom');
  });
});

describe('supabasePaging.fetchAllByInChunks', () => {
  it('chunks a large id input AND range-pages each chunk (>1000 in and out)', async () => {
    const perChunk = 1200;
    const ids = Array.from({ length: 1500 }, (_, i) => `slot-${i}`);
    const sources = new Map<string, ReturnType<typeof makeSource>>();
    const distinctChunks = new Set<string>();
    const seenChunkSizes: number[] = [];
    const out = await fetchAllByInChunks<{ id: string }>(ids, (idChunk) => {
      const key = idChunk.join(',');
      if (!sources.has(key)) {
        sources.set(key, makeSource(perChunk));
        distinctChunks.add(key);
        seenChunkSizes.push(idChunk.length);
      }
      return sources.get(key)!.build();
    });
    const expectedChunks = Math.ceil(ids.length / SUPABASE_IN_CHUNK_SIZE);
    expect(distinctChunks.size).toBe(expectedChunks);
    expect(Math.max(...seenChunkSizes)).toBeLessThanOrEqual(SUPABASE_IN_CHUNK_SIZE);
    expect(out.length).toBe(expectedChunks * perChunk);
  });

  it('empty input does no work', async () => {
    let called = false;
    const out = await fetchAllByInChunks<{ id: string }>([], () => {
      called = true;
      return { range: () => Promise.resolve({ data: [], error: null }) };
    });
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });
});

describe('supabasePaging.chunk', () => {
  it('splits into consecutive bounded groups', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
  });
});
