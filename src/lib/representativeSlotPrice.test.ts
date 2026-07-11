import { describe, it, expect } from 'vitest';
import { representativeSlotPrice } from './cycleDetail';

/**
 * Batch 2 (a): the inline pricing card must seed from the price the slots ACTUALLY charge, not the
 * cycle row (which can drift). representativeSlotPrice returns the most common non-null slot price so
 * a stale cycle value is never pushed back over the real slot prices on save.
 */
describe('representativeSlotPrice', () => {
  const p = (...prices: (number | null)[]) => prices.map((price) => ({ price_per_session: price }));

  it('returns the price when all slots agree', () => {
    expect(representativeSlotPrice(p(76, 76, 76))).toBe(76);
  });

  it('returns the MAJORITY price when one session has drifted (the stray does not win)', () => {
    // 11 slots at 76, one stale 73 — the card should seed 76, not the stray.
    expect(representativeSlotPrice(p(...Array(11).fill(76), 73))).toBe(76);
  });

  it('ignores null slot prices', () => {
    expect(representativeSlotPrice(p(null, 50, 50, null))).toBe(50);
  });

  it('returns null when no slot carries a price (caller falls back to the cycle row)', () => {
    expect(representativeSlotPrice(p(null, null))).toBeNull();
    expect(representativeSlotPrice([])).toBeNull();
  });

  it('a two-way tie resolves deterministically to the first-seen price', () => {
    expect(representativeSlotPrice(p(60, 70))).toBe(60);
  });
});
