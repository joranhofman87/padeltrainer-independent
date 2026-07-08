import { describe, it, expect, vi, beforeEach } from 'vitest';

// freePlayerRebookSeat orchestrates two existing safe ops: cancel the invitee's bookings
// (which resyncs the split invoices) + decline each of their claims. Mock both to prove the
// orchestration (right args, all claims declined, errors surfaced) without touching the DB.
const cancelPlayerBookingsInCycle = vi.fn();
const declineClaimAsManager = vi.fn();

vi.mock('@/lib/bookings', () => ({
  cancelPlayerBookingsInCycle: (...a: unknown[]) => cancelPlayerBookingsInCycle(...a),
}));
vi.mock('@/lib/priorityClaims', () => ({
  cancelPlayerBookingsInCycle: undefined,
  declineClaimAsManager: (...a: unknown[]) => declineClaimAsManager(...a),
  // rebookManage.ts also imports these from priorityClaims at module load.
  releaseSlotToPublic: vi.fn(),
  holdSlotForReview: vi.fn(),
}));
vi.mock('@/lib/cycleWrites', () => ({ updateCycleSettings: vi.fn() }));

import { freePlayerRebookSeat } from './rebookManage';

beforeEach(() => {
  cancelPlayerBookingsInCycle.mockReset();
  declineClaimAsManager.mockReset();
});

describe('freePlayerRebookSeat', () => {
  it('cancels the player bookings on the series slots, then declines every claim', async () => {
    cancelPlayerBookingsInCycle.mockResolvedValue({ cancelError: null, syncError: null, cancelledCount: 2 });
    declineClaimAsManager.mockResolvedValue(undefined);

    const res = await freePlayerRebookSeat({
      slotIds: ['s1', 's2'],
      player: { playerId: 'p1', guestPlayerId: null },
      claimIds: ['c1', 'c2'],
    });

    expect(cancelPlayerBookingsInCycle).toHaveBeenCalledWith(['s1', 's2'], { playerId: 'p1', guestPlayerId: null });
    expect(declineClaimAsManager).toHaveBeenCalledTimes(2);
    expect(declineClaimAsManager).toHaveBeenCalledWith('c1', expect.any(String));
    expect(declineClaimAsManager).toHaveBeenCalledWith('c2', expect.any(String));
    expect(res).toEqual({ cancelledCount: 2, declinedCount: 2, cancelError: null, syncError: null });
  });

  it('surfaces a booking-cancel error and does not throw', async () => {
    cancelPlayerBookingsInCycle.mockResolvedValue({ cancelError: { message: 'RLS denied' }, syncError: null, cancelledCount: 0 });

    const res = await freePlayerRebookSeat({ slotIds: ['s1'], player: { playerId: 'p1', guestPlayerId: null }, claimIds: ['c1'] });

    expect(res.cancelError).toBe('RLS denied');
    // claims are still declined (independent lever) — best-effort cleanup
    expect(declineClaimAsManager).toHaveBeenCalledWith('c1', expect.any(String));
  });
});
