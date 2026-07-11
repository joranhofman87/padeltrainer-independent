import { describe, it, expect } from 'vitest';
import { buildCycleExtensionBookings } from './cycleExtensionBookings';

/**
 * Batch 2 (d): a repeat-count cycle extension must born its NEW sessions clean — confirmed + unpaid —
 * never inheriting the template booking's 'attended'/'paid' state (which minted added weeks as paid
 * with no money received).
 */
describe('buildCycleExtensionBookings', () => {
  it('the NEW sessions are always confirmed + pending, even when the template player already PAID', () => {
    // A player whose existing sessions are confirmed + PAID (the trigger for the old bug).
    const rows = buildCycleExtensionBookings(
      [{ player_id: 'p1', guest_player_id: null, payment_amount: 76, /* would-be-inherited: */ } as never],
      ['newS1', 'newS2'],
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.status).toBe('confirmed');   // not the template's possibly-'attended' status
      expect(r.payment_status).toBe('pending'); // UNPAID — the player owes for the added weeks
      expect(r.payment_amount).toBe(76); // per-session price carried over
    }
  });

  it('carries every unique player/guest onto every new slot', () => {
    const rows = buildCycleExtensionBookings(
      [
        { player_id: 'p1', guest_player_id: null, payment_amount: 50 },
        { player_id: null, guest_player_id: 'g1', payment_amount: 50 },
      ],
      ['s1', 's2'],
    );
    expect(rows).toHaveLength(4); // 2 players × 2 slots
    expect(rows.filter((r) => r.player_id === 'p1')).toHaveLength(2);
    expect(rows.filter((r) => r.guest_player_id === 'g1')).toHaveLength(2);
  });

  it('dedups templates by identity (first booking per player wins)', () => {
    const rows = buildCycleExtensionBookings(
      [
        { player_id: 'p1', guest_player_id: null, payment_amount: 40 },
        { player_id: 'p1', guest_player_id: null, payment_amount: 40 }, // duplicate existing booking
      ],
      ['s1'],
    );
    expect(rows).toHaveLength(1); // p1 booked once on the new slot, not twice
  });

  it('empty inputs → no rows', () => {
    expect(buildCycleExtensionBookings([], ['s1'])).toEqual([]);
    expect(buildCycleExtensionBookings([{ player_id: 'p1', guest_player_id: null, payment_amount: 10 }], [])).toEqual([]);
  });
});
