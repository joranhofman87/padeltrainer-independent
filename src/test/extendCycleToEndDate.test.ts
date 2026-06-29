import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Contract for the cycle-extension create-lib: it copies each template slot's attributes verbatim
 * (minus identity/audit columns) onto the new dates, records the new end_date, and inserts the
 * generated rows. The date math itself is covered by cycleExtension.test.ts (the pure planner).
 */
const h = vi.hoisted(() => {
  const state: { slots: Record<string, unknown>[] } = { slots: [] };
  const insertSpy = vi.fn(() => Promise.resolve({ error: null }));
  const updateCycleSpy = vi.fn(() => Promise.resolve(undefined));

  function builder(getRows: () => Record<string, unknown>[]) {
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    const rows = () => getRows().filter((r) => filters.every((f) => f(r)));
    const api: Record<string, unknown> = {
      select: () => api,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return api; },
      maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (v: { data: Record<string, unknown>[]; error: null }) => unknown) =>
        Promise.resolve({ data: rows(), error: null }).then(resolve),
    };
    return api;
  }
  const supabase = {
    from: (table: string) => {
      if (table === 'cycles') return builder(() => [{ id: 'cy1', owner_type: 'academy', owner_id: 'a1' }]);
      if (table === 'academy_profiles') return builder(() => [{ id: 'a1', timezone: 'Europe/Amsterdam' }]);
      if (table === 'availability_slots') return builder(() => state.slots);
      return builder(() => []);
    },
  };
  return { state, supabase, insertSpy, updateCycleSpy };
});

vi.mock('@/lib/supabaseClient', () => ({ supabase: h.supabase }));
vi.mock('@/lib/slots', () => ({ insertAvailabilitySlots: (rows: unknown) => h.insertSpy(rows) }));
vi.mock('@/lib/cycles', () => ({ updateCycle: (id: string, patch: unknown) => h.updateCycleSpy(id, patch) }));

import { extendCycleToEndDate } from '@/lib/cycleExtension';

beforeEach(() => { h.insertSpy.mockClear(); h.updateCycleSpy.mockClear(); });

describe('extendCycleToEndDate (create-lib)', () => {
  it('copies template attributes onto the new sessions, records end_date, inserts', async () => {
    // One Monday slot (2026-01-05 18:00 Amsterdam = 17:00 UTC), fully attributed.
    h.state.slots = [{
      id: 's1', cyclus_id: 'cy1', start_time: '2026-01-05T17:00:00.000Z', end_time: '2026-01-05T18:00:00.000Z',
      trainer_id: 'tr1', location_id: 'loc1', court_type: 'indoor', price_per_session: 12, max_participants: 4,
      is_public: true, split_payment: true, rating_system: 'knltb', created_at: 'X', updated_at: 'Y',
    }];

    const res = await extendCycleToEndDate('cy1', '2026-01-19');

    expect(res.added).toBe(2); // Jan 12 + Jan 19
    expect(h.updateCycleSpy).toHaveBeenCalledWith('cy1', { end_date: '2026-01-19' });

    const rows = h.insertSpy.mock.calls[0][0] as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    // Identity/audit columns are NOT copied; everything else carries over.
    for (const r of rows) {
      expect(r.id).toBeUndefined();
      expect(r.created_at).toBeUndefined();
      expect(r.updated_at).toBeUndefined();
      expect(r).toMatchObject({
        cyclus_id: 'cy1', trainer_id: 'tr1', location_id: 'loc1', court_type: 'indoor',
        price_per_session: 12, max_participants: 4, is_public: true, split_payment: true, rating_system: 'knltb',
      });
    }
    expect(rows.map((r) => r.start_time)).toEqual(['2026-01-12T17:00:00.000Z', '2026-01-19T17:00:00.000Z']);
    expect(rows.every((r) => r.end_time === (r.start_time as string).replace('17:00', '18:00'))).toBe(true);
  });

  it('records the end_date but inserts nothing when not extending (shorten/same)', async () => {
    h.state.slots = [{ id: 's1', cyclus_id: 'cy1', start_time: '2026-01-19T17:00:00.000Z', end_time: '2026-01-19T18:00:00.000Z' }];
    const res = await extendCycleToEndDate('cy1', '2026-01-05');
    expect(res.added).toBe(0);
    expect(h.updateCycleSpy).toHaveBeenCalledWith('cy1', { end_date: '2026-01-05' });
    expect(h.insertSpy).not.toHaveBeenCalled();
  });

  it('no-op for a cycle with no slots', async () => {
    h.state.slots = [];
    const res = await extendCycleToEndDate('cy1', '2026-01-19');
    expect(res.added).toBe(0);
    expect(h.insertSpy).not.toHaveBeenCalled();
    expect(h.updateCycleSpy).not.toHaveBeenCalled();
  });
});
