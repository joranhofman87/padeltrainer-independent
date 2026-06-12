import { describe, it, expect } from 'vitest';
import {
  isCycleDueForInvoicing,
  isOpenCommitment,
  committerKey,
  buildCommitmentInvoicePlan,
  type CommitmentBooking,
} from '../../supabase/functions/_shared/cycle-commitment-invoicing.ts';
import { applySplitPayment } from '../../supabase/functions/_shared/booking-pricing.ts';

const NOW = new Date('2026-06-10T12:00:00.000Z');

const booking = (over: Partial<CommitmentBooking> & { id: string }): CommitmentBooking => ({
  slot_id: 'slot-1',
  player_id: null,
  guest_player_id: null,
  payment_status: 'pending',
  status: 'confirmed',
  ...over,
});

describe('isCycleDueForInvoicing', () => {
  it('is due once the cycle start has passed', () => {
    expect(isCycleDueForInvoicing('2026-06-01T00:00:00.000Z', NOW)).toBe(true);
    expect(isCycleDueForInvoicing('2026-06-10T12:00:00.000Z', NOW)).toBe(true);
  });
  it('is not due before the cycle starts, or with no/invalid date', () => {
    expect(isCycleDueForInvoicing('2026-06-20T00:00:00.000Z', NOW)).toBe(false);
    expect(isCycleDueForInvoicing(null, NOW)).toBe(false);
    expect(isCycleDueForInvoicing('not-a-date', NOW)).toBe(false);
  });
});

describe('isOpenCommitment / committerKey', () => {
  it('open when active and unpaid', () => {
    expect(isOpenCommitment(booking({ id: 'b1' }))).toBe(true);
  });
  it('closed when already paid or cancelled', () => {
    expect(isOpenCommitment(booking({ id: 'b1', payment_status: 'paid' }))).toBe(false);
    expect(isOpenCommitment(booking({ id: 'b1', status: 'cancelled' }))).toBe(false);
    expect(isOpenCommitment(booking({ id: 'b1', status: 'cancelled_swap' }))).toBe(false);
  });
  it('prefers player_id then guest_player_id', () => {
    expect(committerKey(booking({ id: 'b1', player_id: 'p1' }))).toBe('p1');
    expect(committerKey(booking({ id: 'b1', guest_player_id: 'g1' }))).toBe('g1');
    expect(committerKey(booking({ id: 'b1' }))).toBe(null);
  });
});

describe('buildCommitmentInvoicePlan', () => {
  it('one batch per committer; group N = players sharing the slots', () => {
    // p1, p2, g1 all share slot-1 (one group of 3); p1 has two sessions.
    const plan = buildCommitmentInvoicePlan([
      booking({ id: 'b1', slot_id: 's1', player_id: 'p1' }),
      booking({ id: 'b2', slot_id: 's2', player_id: 'p1' }),
      booking({ id: 'b3', slot_id: 's1', player_id: 'p2' }),
      booking({ id: 'b4', slot_id: 's1', guest_player_id: 'g1' }),
      booking({ id: 'b5', slot_id: 's2', player_id: 'p2' }),
      booking({ id: 'b6', slot_id: 's2', guest_player_id: 'g1' }),
    ]);
    expect(plan.committerCount).toBe(3);
    const p1 = plan.batches.find((b) => b.playerKey === 'p1');
    expect(p1?.bookingIds.sort()).toEqual(['b1', 'b2']);
    expect(p1?.splitAmongPlayers).toBe(3);
  });

  it('ignores cancelled bookings and keyless rows; paid committers still count toward N', () => {
    const plan = buildCommitmentInvoicePlan([
      booking({ id: 'b1', player_id: 'p1' }),
      booking({ id: 'b2', player_id: 'p2', payment_status: 'paid' }),
      booking({ id: 'b3', player_id: 'p3', status: 'cancelled' }),
      booking({ id: 'b4' }), // no key
    ]);
    // p1 + p2 committed (p2 already paid → no batch, but stays in the group);
    // cancelled p3 and the keyless row are ignored entirely.
    expect(plan.committerCount).toBe(2);
    expect(plan.batches).toEqual([{ playerKey: 'p1', bookingIds: ['b1'], splitAmongPlayers: 2 }]);
  });

  it('M-19: a committer paying between runs does not shrink the divisor for the rest', () => {
    const group = [
      booking({ id: 'b1', slot_id: 's1', player_id: 'p1' }),
      booking({ id: 'b2', slot_id: 's1', player_id: 'p2' }),
      booking({ id: 'b3', slot_id: 's1', player_id: 'p3' }),
    ];
    const before = buildCommitmentInvoicePlan(group);
    // p1 pays their commitment invoice; a later run must still bill p2/p3 at N=3.
    const after = buildCommitmentInvoicePlan([
      { ...group[0], payment_status: 'paid' },
      group[1],
      group[2],
    ]);
    expect(before.batches.find((b) => b.playerKey === 'p2')?.splitAmongPlayers).toBe(3);
    expect(after.batches.map((b) => b.playerKey).sort()).toEqual(['p2', 'p3']);
    expect(after.batches.every((b) => b.splitAmongPlayers === 3)).toBe(true);
  });

  it('splits PER GROUP, not per cycle: two groups in one cycle bill independently', () => {
    // Group A on slot a1 (p1, p2 → N=2); group B on slot b1 (p3 alone → N=1).
    const plan = buildCommitmentInvoicePlan([
      booking({ id: 'b1', slot_id: 'a1', player_id: 'p1' }),
      booking({ id: 'b2', slot_id: 'a1', player_id: 'p2' }),
      booking({ id: 'b3', slot_id: 'b1', player_id: 'p3' }),
    ]);
    expect(plan.committerCount).toBe(3);
    expect(plan.batches.find((b) => b.playerKey === 'p1')?.splitAmongPlayers).toBe(2);
    expect(plan.batches.find((b) => b.playerKey === 'p2')?.splitAmongPlayers).toBe(2);
    expect(plan.batches.find((b) => b.playerKey === 'p3')?.splitAmongPlayers).toBe(1);
  });

  it('group N feeds the split: group total €120 over 2 players → €60 each', () => {
    const cycleTotal = 120; // price_per_session 15 x 8 sessions
    const plan = buildCommitmentInvoicePlan([
      booking({ id: 'b1', slot_id: 's1', player_id: 'p1' }),
      booking({ id: 'b2', slot_id: 's1', player_id: 'p2' }),
    ]);
    const n = plan.batches[0].splitAmongPlayers;
    expect(n).toBe(2);
    expect(applySplitPayment(cycleTotal, n)).toBe(60);
  });
});
