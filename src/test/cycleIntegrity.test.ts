import { describe, it, expect, vi, beforeEach } from 'vitest';

const cyclesMaybeSingle = vi.fn();
const slotsCount = vi.fn();

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: (table: string) => {
      if (table === 'cycles') {
        return { select: () => ({ eq: () => ({ maybeSingle: cyclesMaybeSingle }) }) };
      }
      // availability_slots count: select('id', {count,head}).eq('cyclus_id', id) → { count }
      return { select: () => ({ eq: () => slotsCount() }) };
    },
  },
}));

import { classifyCyclusId, isTrainingCycle, isBrokenCyclusLink } from '@/lib/cycleIntegrity';

describe('classifyCyclusId', () => {
  beforeEach(() => vi.clearAllMocks());

  it('null/undefined → missing, no query', async () => {
    const r = await classifyCyclusId(null);
    expect(r.kind).toBe('missing');
    expect(cyclesMaybeSingle).not.toHaveBeenCalled();
  });

  it('type=cyclus → training_cycle', async () => {
    cyclesMaybeSingle.mockResolvedValueOnce({ data: { id: 'c1', type: 'cyclus' }, error: null });
    const r = await classifyCyclusId('c1');
    expect(r.kind).toBe('training_cycle');
    expect(isTrainingCycle(r)).toBe(true);
    expect(isBrokenCyclusLink(r)).toBe(false);
  });

  it('type=registration → registration', async () => {
    cyclesMaybeSingle.mockResolvedValueOnce({ data: { id: 'r1', type: 'registration' }, error: null });
    expect((await classifyCyclusId('r1')).kind).toBe('registration');
  });

  it('type=event → event', async () => {
    cyclesMaybeSingle.mockResolvedValueOnce({ data: { id: 'e1', type: 'event' }, error: null });
    expect((await classifyCyclusId('e1')).kind).toBe('event');
  });

  it('no cycles row but slots exist → orphan_slot_group', async () => {
    cyclesMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    slotsCount.mockResolvedValueOnce({ count: 3, error: null });
    const r = await classifyCyclusId('orphan');
    expect(r).toEqual({ kind: 'orphan_slot_group', cyclusId: 'orphan', slotCount: 3 });
    expect(isBrokenCyclusLink(r)).toBe(true);
  });

  it('no cycles row and no slots → missing', async () => {
    cyclesMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    slotsCount.mockResolvedValueOnce({ count: 0, error: null });
    expect((await classifyCyclusId('gone')).kind).toBe('missing');
  });
});
