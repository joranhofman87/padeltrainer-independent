import { describe, it, expect, vi } from 'vitest';
import { supabaseMock, setMockData } from './fixtures/supabaseMock';

vi.mock('@/lib/supabaseClient', () => ({ supabase: supabaseMock }));
import { countCyclesIntakes } from '@/lib/cycles';

describe('countCyclesIntakes wrapper', () => {
  it('maps the RPC rows into a Map<cycleId, count> (coercing bigint), absent cycle → not in map', async () => {
    setMockData({}, {
      count_cycles_intakes: () => ({ data: [{ cycle_id: 'c1', n: 3 }, { cycle_id: 'c2', n: '2' }], error: null }),
    });
    const m = await countCyclesIntakes(['c1', 'c2', 'c3']);
    expect(m.get('c1')).toBe(3);
    expect(m.get('c2')).toBe(2); // string bigint coerced
    expect(m.has('c3')).toBe(false); // no intakes → absent (caller treats as 0)
  });

  it('empty input short-circuits with no RPC call', async () => {
    const spy = vi.fn();
    setMockData({}, {
      count_cycles_intakes: () => {
        spy();
        return { data: [], error: null };
      },
    });
    const m = await countCyclesIntakes([]);
    expect(m.size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('throws on RPC error (caller falls back)', async () => {
    setMockData({}, { count_cycles_intakes: () => ({ data: null, error: { message: 'boom' } }) });
    await expect(countCyclesIntakes(['c1'])).rejects.toBeTruthy();
  });
});
