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
  it('groups one batch per committer and counts headcount', () => {
    const plan = buildCommitmentInvoicePlan([
      booking({ id: 'b1', player_id: 'p1' }),
      booking({ id: 'b2', player_id: 'p1' }), // same player, two sessions
      booking({ id: 'b3', player_id: 'p2' }),
      booking({ id: 'b4', guest_player_id: 'g1' }),
    ]);
    expect(plan.committerCount).toBe(3);
    const p1 = plan.batches.find((b) => b.playerKey === 'p1');
    expect(p1?.bookingIds.sort()).toEqual(['b1', 'b2']);
  });

  it('ignores paid/cancelled bookings and keyless rows when counting N', () => {
    const plan = buildCommitmentInvoicePlan([
      booking({ id: 'b1', player_id: 'p1' }),
      booking({ id: 'b2', player_id: 'p2', payment_status: 'paid' }),
      booking({ id: 'b3', player_id: 'p3', status: 'cancelled' }),
      booking({ id: 'b4' }), // no key
    ]);
    expect(plan.committerCount).toBe(1);
    expect(plan.batches).toEqual([{ playerKey: 'p1', bookingIds: ['b1'] }]);
  });

  it('headcount feeds the existing split: 2 of 4 committed → each pays half', () => {
    const cycleTotal = 120; // e.g. price_per_session 15 x 8 sessions
    const plan = buildCommitmentInvoicePlan([
      booking({ id: 'b1', player_id: 'p1' }),
      booking({ id: 'b2', player_id: 'p2' }),
    ]);
    expect(plan.committerCount).toBe(2);
    expect(applySplitPayment(cycleTotal, plan.committerCount)).toBe(60);
  });
});
