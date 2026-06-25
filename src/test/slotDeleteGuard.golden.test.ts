import { describe, it, expect, vi, beforeEach } from 'vitest';
import { supabaseMock, setMockData } from './fixtures/supabaseMock';

vi.mock('@/lib/supabaseClient', () => ({ supabase: supabaseMock }));
import { findBookedSlotIds, filterDeletableSlotIds } from '@/lib/slotDeleteGuard';

/**
 * GOLDEN — the protected-set logic the F2 `apply_slot_delete_to_cycle` RPC must reproduce exactly:
 * a slot is protected (NOT deletable) iff it has a booking in a capacity-occupying status
 * (confirmed / pending / pending_approval). cancelled / declined / no-booking → deletable.
 * `bookings.slot_id` is ON DELETE CASCADE, so getting this wrong deletes paid bookings.
 */
describe('GOLDEN: slot delete-guard protected set', () => {
  beforeEach(() =>
    setMockData({
      bookings: [
        { slot_id: 's1', status: 'confirmed' },
        { slot_id: 's2', status: 'cancelled' },
        { slot_id: 's3', status: 'pending_approval' },
        { slot_id: 's4', status: 'pending' },
        { slot_id: 's5', status: 'declined' },
      ],
    }),
  );

  it('findBookedSlotIds = only slots with a capacity-occupying booking', async () => {
    const booked = await findBookedSlotIds(['s1', 's2', 's3', 's4', 's5', 's6']);
    expect([...booked].sort()).toEqual(['s1', 's3', 's4']);
  });

  it('filterDeletableSlotIds = the slots safe to hard-delete (no active booking)', async () => {
    const deletable = await filterDeletableSlotIds(['s1', 's2', 's3', 's4', 's5', 's6']);
    expect(deletable.sort()).toEqual(['s2', 's5', 's6']);
  });

  it('empty input short-circuits with no query', async () => {
    expect([...(await findBookedSlotIds([]))]).toEqual([]);
    expect(await filterDeletableSlotIds([])).toEqual([]);
  });
});
