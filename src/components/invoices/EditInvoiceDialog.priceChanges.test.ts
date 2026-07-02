import { describe, it, expect } from 'vitest';
import { hasLineItemPriceChanges } from './EditInvoiceDialog';

const li = (description: string, unit_price: number) => ({ description, unit_price });

describe('hasLineItemPriceChanges (P2-13)', () => {
  it('does not misfire when an untouched middle row is deleted', () => {
    const original = [li('Lesson A', 10), li('Lesson B', 20), li('Lesson C', 30)];
    const current = [li('Lesson A', 10), li('Lesson C', 30)]; // B removed, indices shifted
    // Index-based logic compared C(30) vs original[1]=B(20) -> false-positive.
    expect(hasLineItemPriceChanges(original, current)).toBe(false);
  });

  it('does not misfire when the first row is deleted', () => {
    const original = [li('A', 10), li('B', 20)];
    const current = [li('B', 20)];
    expect(hasLineItemPriceChanges(original, current)).toBe(false);
  });

  it('detects an actual price edit', () => {
    expect(hasLineItemPriceChanges([li('A', 10)], [li('A', 12)])).toBe(true);
  });

  it('detects a newly added row', () => {
    expect(hasLineItemPriceChanges([li('A', 10)], [li('A', 10), li('B', 5)])).toBe(true);
  });

  it('matches duplicate descriptions 1:1 (deleting one duplicate is not a change)', () => {
    const original = [li('Extra', 5), li('Extra', 5)];
    const current = [li('Extra', 5)];
    expect(hasLineItemPriceChanges(original, current)).toBe(false);
  });

  it('detects a price edit even when a duplicate exists', () => {
    const original = [li('Extra', 5), li('Extra', 5)];
    const current = [li('Extra', 5), li('Extra', 9)];
    expect(hasLineItemPriceChanges(original, current)).toBe(true);
  });
});
