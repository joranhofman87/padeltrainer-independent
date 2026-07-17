import { describe, it, expect, vi, beforeEach } from 'vitest';

const cancelMock = vi.fn();
const swapMock = vi.fn();
vi.mock('@/lib/bookings', () => ({
  cancelPlayerBookingsInCycle: (...a: unknown[]) => cancelMock(...a),
}));
vi.mock('@/lib/cycleRoster', () => ({
  swapPlayerInCycle: (...a: unknown[]) => swapMock(...a),
}));

import {
  refsOfEntry,
  pickerExcludeKeysFor,
  removePersonFromCycle,
  swapPersonInCycle,
} from './cycleRosterPerson';

const MERGED = {
  playerId: null,
  guestPlayerId: 'g1',
  refs: [
    { playerId: null, guestPlayerId: 'g1' },
    { playerId: 'p1', guestPlayerId: null },
  ],
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  cancelMock.mockResolvedValue({ cancelError: null, syncError: null, cancelledCount: 2, declinedClaimCount: 0, paidClaimBookingIds: [] });
  swapMock.mockResolvedValue({ error: null, reassignedCount: 3, cancelledCollisionCount: 0, syncFailed: false });
});

describe('refsOfEntry / pickerExcludeKeysFor (Phase 3.1 merged-person roster actions)', () => {
  it('falls back to the primary XOR pair for legacy single-ref entries', () => {
    expect(refsOfEntry({ playerId: 'p1', guestPlayerId: null, refs: [] })).toEqual([
      { playerId: 'p1', guestPlayerId: null },
    ]);
    expect(refsOfEntry({ playerId: null, guestPlayerId: null, refs: [] })).toEqual([]);
  });

  it('excludes BOTH picker rows of a merged person (g_ and p_)', () => {
    expect(pickerExcludeKeysFor(MERGED).sort()).toEqual(['g_g1', 'p_p1']);
  });
});

describe('removePersonFromCycle — the whole person, once per ref', () => {
  it('calls the old-world cancel ONCE PER REF and sums the counts', async () => {
    const res = await removePersonFromCycle(['s1', 's2'], MERGED, {} as never, { skipInvoiceSync: true });
    expect(cancelMock).toHaveBeenCalledTimes(2);
    expect(cancelMock).toHaveBeenNthCalledWith(1, ['s1', 's2'], { playerId: null, guestPlayerId: 'g1' }, {}, { skipInvoiceSync: true });
    expect(cancelMock).toHaveBeenNthCalledWith(2, ['s1', 's2'], { playerId: 'p1', guestPlayerId: null }, {}, { skipInvoiceSync: true });
    expect(res.cancelledCount).toBe(4); // 2 + 2 — no half of the person stays seated
  });

  it('throws on a cancel error (retry is safe: already-cancelled refs return zero matches)', async () => {
    cancelMock
      .mockResolvedValueOnce({ cancelError: null, syncError: null, cancelledCount: 2, declinedClaimCount: 0, paidClaimBookingIds: [] })
      .mockResolvedValueOnce({ cancelError: new Error('boom'), syncError: null, cancelledCount: 0, declinedClaimCount: 0, paidClaimBookingIds: [] });
    await expect(removePersonFromCycle(['s1'], MERGED, {} as never)).rejects.toThrow('boom');
  });

  it('surfaces the first sync error without failing the removal', async () => {
    cancelMock
      .mockResolvedValueOnce({ cancelError: null, syncError: new Error('sync'), cancelledCount: 1, declinedClaimCount: 0, paidClaimBookingIds: [] })
      .mockResolvedValueOnce({ cancelError: null, syncError: null, cancelledCount: 1, declinedClaimCount: 0, paidClaimBookingIds: [] });
    const res = await removePersonFromCycle(['s1'], MERGED, {} as never);
    expect(res.cancelledCount).toBe(2);
    expect(res.syncError).toBeInstanceOf(Error);
  });
});

describe('swapPersonInCycle — one swap per ref, same incoming person', () => {
  it('swaps each ref to the SAME incoming guest and aggregates the counts', async () => {
    swapMock
      .mockResolvedValueOnce({ error: null, reassignedCount: 3, cancelledCollisionCount: 0, syncFailed: false })
      .mockResolvedValueOnce({ error: null, reassignedCount: 1, cancelledCollisionCount: 1, syncFailed: true });
    const res = await swapPersonInCycle({
      cycleId: 'cy1',
      fromEntry: MERGED,
      toGuestPlayerId: 'g-new',
      toProfileId: 'p-new',
      skipInvoices: false,
    });
    expect(swapMock).toHaveBeenCalledTimes(2);
    expect(swapMock.mock.calls[0][0]).toMatchObject({ fromPlayer: { playerId: null, guestPlayerId: 'g1' }, toGuestPlayerId: 'g-new', toProfileId: 'p-new' });
    expect(swapMock.mock.calls[1][0]).toMatchObject({ fromPlayer: { playerId: 'p1', guestPlayerId: null }, toGuestPlayerId: 'g-new', toProfileId: 'p-new' });
    expect(res).toEqual({ reassignedCount: 4, cancelledCollisionCount: 1, syncFailed: true });
  });

  it('throws on the first swap error (later refs untouched)', async () => {
    swapMock.mockResolvedValueOnce({ error: new Error('nope'), reassignedCount: 0, cancelledCollisionCount: 0, syncFailed: false });
    await expect(
      swapPersonInCycle({ cycleId: 'cy1', fromEntry: MERGED, toGuestPlayerId: 'g-new' }),
    ).rejects.toThrow('nope');
    expect(swapMock).toHaveBeenCalledTimes(1);
  });
});
