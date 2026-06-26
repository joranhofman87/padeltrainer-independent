import { describe, it, expect, vi } from 'vitest';
import { supabaseMock, setMockData } from './fixtures/supabaseMock';

vi.mock('@/lib/supabaseClient', () => ({ supabase: supabaseMock }));
import { applySlotDeleteToCycle } from '@/lib/slotDeleteGuard';

describe('applySlotDeleteToCycle wrapper', () => {
  it('maps the RPC row into a SlotDeleteResult (coercing bigint counts)', async () => {
    setMockData({}, {
      apply_slot_delete_to_cycle: () => ({
        data: [{ deleted_count: '2', protected_count: 1, protected_slot_ids: ['s1'] }],
        error: null,
      }),
    });
    const r = await applySlotDeleteToCycle('cy1', ['s1', 's2', 's3']);
    expect(r).toEqual({ deletedCount: 2, protectedCount: 1, protectedSlotIds: ['s1'] });
  });

  it('null protected_slot_ids → empty array (never undefined)', async () => {
    setMockData({}, {
      apply_slot_delete_to_cycle: () => ({
        data: [{ deleted_count: 1, protected_count: 0, protected_slot_ids: null }],
        error: null,
      }),
    });
    const r = await applySlotDeleteToCycle('cy1', ['s1']);
    expect(r.protectedSlotIds).toEqual([]);
    expect(r.protectedCount).toBe(0);
  });

  it('empty slotIds short-circuits with no RPC call', async () => {
    const spy = vi.fn();
    setMockData({}, {
      apply_slot_delete_to_cycle: () => {
        spy();
        return { data: [], error: null };
      },
    });
    const r = await applySlotDeleteToCycle('cy1', []);
    expect(r).toEqual({ deletedCount: 0, protectedCount: 0, protectedSlotIds: [] });
    expect(spy).not.toHaveBeenCalled();
  });

  it('throws on RPC error (caller falls back / surfaces the failure)', async () => {
    setMockData({}, { apply_slot_delete_to_cycle: () => ({ data: null, error: { message: 'boom' } }) });
    await expect(applySlotDeleteToCycle('cy1', ['s1'])).rejects.toBeTruthy();
  });
});
