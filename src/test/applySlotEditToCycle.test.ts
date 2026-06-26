import { describe, it, expect, vi } from 'vitest';
import { supabaseMock, setMockData } from './fixtures/supabaseMock';

vi.mock('@/lib/supabaseClient', () => ({ supabase: supabaseMock }));
import { applySlotEditToCycle } from '@/lib/cycles';

describe('applySlotEditToCycle wrapper', () => {
  it('builds a snake_case _patch with ONLY present keys (explicit null preserved) + coerces counts', async () => {
    type EditArgs = { _cycle_id: string | null; _slot_ids: string[]; _patch: Record<string, unknown> };
    let captured: EditArgs | undefined;
    setMockData({}, {
      apply_slot_edit_to_cycle: (args) => {
        captured = args as unknown as EditArgs;
        return { data: [{ updated_count: '2', blocked_count: 0, blocked_slot_ids: [] }], error: null };
      },
    });
    const r = await applySlotEditToCycle('cy1', ['s1', 's2'], {
      startShiftMinutes: 60,
      durationMinutes: 90,
      trainerId: 'tr2',
      locationId: null, // explicit null must be sent → clears the column
      isPublic: false,
    });
    expect(r).toEqual({ updatedCount: 2, blockedCount: 0, blockedSlotIds: [] });
    expect(captured?._cycle_id).toBe('cy1');
    expect(captured?._slot_ids).toEqual(['s1', 's2']);
    // Only the keys we set are present; minRating/maxRating/cyclusName/maxParticipants are absent.
    expect(captured?._patch).toEqual({
      start_shift_minutes: 60,
      duration_minutes: 90,
      trainer_id: 'tr2',
      location_id: null,
      is_public: false,
    });
    expect('max_participants' in (captured?._patch ?? {})).toBe(false);
  });

  it('passes through a blocked (capacity-shrink) result', async () => {
    setMockData({}, {
      apply_slot_edit_to_cycle: () => ({
        data: [{ updated_count: 0, blocked_count: 1, blocked_slot_ids: ['s3'] }],
        error: null,
      }),
    });
    const r = await applySlotEditToCycle('cy1', ['s3', 's4'], { maxParticipants: 2 });
    expect(r).toEqual({ updatedCount: 0, blockedCount: 1, blockedSlotIds: ['s3'] });
  });

  it('empty slotIds OR empty patch short-circuits with no RPC call', async () => {
    const spy = vi.fn();
    setMockData({}, {
      apply_slot_edit_to_cycle: () => {
        spy();
        return { data: [], error: null };
      },
    });
    expect(await applySlotEditToCycle('cy1', [], { isPublic: true })).toEqual({
      updatedCount: 0, blockedCount: 0, blockedSlotIds: [],
    });
    expect(await applySlotEditToCycle('cy1', ['s1'], {})).toEqual({
      updatedCount: 0, blockedCount: 0, blockedSlotIds: [],
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('throws when only one of startShiftMinutes / durationMinutes is provided (both-or-neither)', async () => {
    await expect(applySlotEditToCycle('cy1', ['s1'], { startShiftMinutes: 30 })).rejects.toThrow(/together/);
    await expect(applySlotEditToCycle('cy1', ['s1'], { durationMinutes: 90 })).rejects.toThrow(/together/);
  });

  it('rounds the integer-typed fields before sending (no fractional ::int cast abort)', async () => {
    let captured: { _patch: Record<string, unknown> } | undefined;
    setMockData({}, {
      apply_slot_edit_to_cycle: (args) => {
        captured = args as unknown as { _patch: Record<string, unknown> };
        return { data: [{ updated_count: 1, blocked_count: 0, blocked_slot_ids: [] }], error: null };
      },
    });
    await applySlotEditToCycle('cy1', ['s1'], { startShiftMinutes: 29.6, durationMinutes: 90.4, maxParticipants: 3.5 });
    expect(captured?._patch).toMatchObject({ start_shift_minutes: 30, duration_minutes: 90, max_participants: 4 });
  });

  it('throws on RPC error', async () => {
    setMockData({}, { apply_slot_edit_to_cycle: () => ({ data: null, error: { message: 'boom' } }) });
    await expect(applySlotEditToCycle('cy1', ['s1'], { isPublic: true })).rejects.toBeTruthy();
  });
});
