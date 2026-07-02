import { describe, it, expect } from 'vitest';
import { resolveSplitDivisor } from './splitDivisor';
// The edge canonical rule — imported cross-boundary in TEST only (app tsconfig excludes it).
import { resolveSplitDivisorFromSlots, applySplitPayment } from '../../supabase/functions/_shared/booking-pricing';

type Slots = { max_participants?: number | null }[];

const CASES: Slots[] = [
  [{ max_participants: 4 }, { max_participants: 4 }],
  [{ max_participants: 4 }, { max_participants: 6 }], // non-uniform → MAX (never overcharge)
  [{ max_participants: 1 }], // no split
  [{ max_participants: null }, { max_participants: 4 }], // null → 1, then MAX = 4
  [{ max_participants: 0 }], // 0 → 1 (no split)
  [], // empty → 1
  [{ max_participants: 2 }, { max_participants: 3 }, { max_participants: 2 }],
];

describe('splitDivisor client mirror ≡ edge canonical rule', () => {
  it('produces identical divisors on every case', () => {
    for (const slots of CASES) {
      expect(resolveSplitDivisor(slots)).toBe(resolveSplitDivisorFromSlots(slots));
    }
  });

  it('MAX capacity is used (never the min → never overcharges)', () => {
    expect(resolveSplitDivisor([{ max_participants: 4 }, { max_participants: 6 }])).toBe(6);
  });

  it('capacity ≤ 1 (or null/empty) → divisor 1 = no split (full price)', () => {
    expect(resolveSplitDivisor([{ max_participants: 1 }])).toBe(1);
    expect(resolveSplitDivisor([{ max_participants: null }])).toBe(1);
    expect(resolveSplitDivisor([])).toBe(1);
    expect(applySplitPayment(40, resolveSplitDivisor([{ max_participants: 1 }]))).toBe(40);
  });

  it('freezes: the divisor is a pure function of slots, independent of any player count', () => {
    const slots = [{ max_participants: 4 }, { max_participants: 4 }];
    // €40 total on a 4-seat court → €10 each, no matter how many have booked.
    expect(applySplitPayment(40, resolveSplitDivisor(slots))).toBe(10);
  });
});
