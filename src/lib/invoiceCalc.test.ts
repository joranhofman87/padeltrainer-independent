import { describe, it, expect } from 'vitest';
import {
  detectSplitCount,
  round2,
  applySplit,
  buildCycleLineItems,
  calculateVatTotals,
  calculateSplitShares,
  type InvoiceLineItem,
} from './invoiceCalc';

describe('detectSplitCount', () => {
  it('returns 1 when no split marker', () => {
    expect(detectSplitCount([{ description: 'Training (10 weken)' }])).toBe(1);
  });

  it('detects (1/2)', () => {
    expect(detectSplitCount([{ description: 'Training (1/2)' }])).toBe(2);
  });

  it('detects (1/4) in second item', () => {
    expect(detectSplitCount([
      { description: 'No split here' },
      { description: 'Training (1/4)' },
    ])).toBe(4);
  });

  it('handles empty array', () => {
    expect(detectSplitCount([])).toBe(1);
  });

  it('handles missing description', () => {
    expect(detectSplitCount([{}])).toBe(1);
  });
});

describe('round2', () => {
  it('rounds to 2 decimal places', () => {
    expect(round2(1.005)).toBe(1); // JS floating point
    expect(round2(1.006)).toBe(1.01);
    expect(round2(10.999)).toBe(11);
    expect(round2(0)).toBe(0);
  });
});

describe('applySplit', () => {
  it('returns original price when splitCount is 1', () => {
    expect(applySplit(100, 1)).toBe(100);
  });

  it('divides by 2', () => {
    expect(applySplit(100, 2)).toBe(50);
  });

  it('divides by 3 and rounds', () => {
    expect(applySplit(100, 3)).toBe(33.33);
  });

  it('divides by 4', () => {
    expect(applySplit(100, 4)).toBe(25);
  });

  it('handles odd amounts', () => {
    expect(applySplit(10, 3)).toBe(3.33);
  });
});

describe('buildCycleLineItems', () => {
  const baseBookings = [
    { paymentAmount: null, slotPricePerSession: 40, startTime: '2025-03-01T10:00:00Z', locationName: 'Court A' },
    { paymentAmount: null, slotPricePerSession: 40, startTime: '2025-03-08T10:00:00Z', locationName: 'Court A' },
  ];

  it('builds single line item for same-price bookings', () => {
    const items = buildCycleLineItems({
      bookings: baseBookings,
      cyclusName: 'Padel cyclus',
      splitCount: 1,
      extraCosts: [],
      defaultVatRate: 21,
    });
    expect(items).toHaveLength(1);
    expect(items[0].quantity).toBe(2);
    expect(items[0].unit_price).toBe(40);
    expect(items[0].description).toContain('2 weken');
  });

  it('applies split count to description and price', () => {
    const items = buildCycleLineItems({
      bookings: baseBookings,
      cyclusName: 'Padel cyclus',
      splitCount: 2,
      extraCosts: [],
      defaultVatRate: 21,
    });
    expect(items[0].unit_price).toBe(20);
    expect(items[0].description).toContain('(1/2)');
  });

  it('falls back to per-session lines for mixed prices', () => {
    const mixed = [
      { paymentAmount: 30, slotPricePerSession: 40, startTime: '2025-03-01T10:00:00Z', locationName: '' },
      { paymentAmount: 50, slotPricePerSession: 40, startTime: '2025-03-08T10:00:00Z', locationName: '' },
    ];
    const items = buildCycleLineItems({
      bookings: mixed,
      cyclusName: 'Mix',
      splitCount: 1,
      extraCosts: [],
      defaultVatRate: 21,
    });
    expect(items).toHaveLength(2);
    expect(items[0].unit_price).toBe(30);
    expect(items[1].unit_price).toBe(50);
  });

  it('adds extra costs with split', () => {
    const items = buildCycleLineItems({
      bookings: baseBookings,
      cyclusName: 'Test',
      splitCount: 3,
      extraCosts: [
        { description: 'Ball costs', price: 9, type: 'one_time' },
        { description: 'Court fee', price: 6, type: 'per_session', vat_rate: 9 },
      ],
      defaultVatRate: 21,
    });
    // 1 session line + 2 extra cost lines
    expect(items).toHaveLength(3);
    expect(items[1].unit_price).toBe(3); // 9/3
    expect(items[1].quantity).toBe(1); // one_time
    expect(items[2].unit_price).toBe(2); // 6/3
    expect(items[2].quantity).toBe(2); // per_session × 2 bookings
    expect(items[2].vat_rate).toBe(9);
  });

  it('skips extra costs with zero price', () => {
    const items = buildCycleLineItems({
      bookings: baseBookings,
      cyclusName: 'Test',
      splitCount: 1,
      extraCosts: [{ description: 'Free', price: 0 }],
      defaultVatRate: 21,
    });
    expect(items).toHaveLength(1);
  });

  it('handles zero-price bookings', () => {
    const zeroBookings = [
      { paymentAmount: null, slotPricePerSession: 0, startTime: '2025-03-01T10:00:00Z', locationName: '' },
    ];
    const items = buildCycleLineItems({
      bookings: zeroBookings,
      cyclusName: 'Free',
      splitCount: 1,
      extraCosts: [],
      defaultVatRate: 21,
    });
    expect(items).toHaveLength(1);
    expect(items[0].unit_price).toBe(0);
  });
});

describe('calculateVatTotals', () => {
  it('single rate VAT inclusive', () => {
    const items: InvoiceLineItem[] = [
      { description: 'Training', quantity: 10, unit_price: 40 },
    ];
    const result = calculateVatTotals(items, 21, true);
    expect(result.total).toBe(400);
    expect(result.subtotal).toBeCloseTo(400 / 1.21, 1);
    expect(result.vatAmount).toBeCloseTo(400 - 400 / 1.21, 1);
    expect(round2(result.subtotal + result.vatAmount)).toBeCloseTo(result.total, 1);
  });

  it('single rate VAT exclusive', () => {
    const items: InvoiceLineItem[] = [
      { description: 'Training', quantity: 10, unit_price: 40 },
    ];
    const result = calculateVatTotals(items, 21, false);
    expect(result.subtotal).toBe(400);
    expect(result.vatAmount).toBe(round2(400 * 0.21));
    expect(result.total).toBe(round2(400 + 400 * 0.21));
  });

  it('multi-rate VAT inclusive', () => {
    const items: InvoiceLineItem[] = [
      { description: 'Training', quantity: 1, unit_price: 121, vat_rate: 21 },
      { description: 'Balls', quantity: 1, unit_price: 10.9, vat_rate: 9 },
    ];
    const result = calculateVatTotals(items, 21, true);
    expect(result.total).toBe(121 + 10.9);
    expect(Object.keys(result.vatBreakdown)).toHaveLength(2);
    // 21% rate: 121 inclusive → sub 100, vat 21
    expect(result.vatBreakdown[21].subtotal).toBe(100);
    expect(result.vatBreakdown[21].vat).toBe(21);
    // 9% rate: 10.9 inclusive → sub 10, vat 0.9
    expect(result.vatBreakdown[9].subtotal).toBe(10);
    expect(result.vatBreakdown[9].vat).toBe(round2(0.9));
  });

  it('multi-rate VAT exclusive', () => {
    const items: InvoiceLineItem[] = [
      { description: 'Training', quantity: 1, unit_price: 100, vat_rate: 21 },
      { description: 'Balls', quantity: 1, unit_price: 10, vat_rate: 9 },
    ];
    const result = calculateVatTotals(items, 21, false);
    expect(result.subtotal).toBe(110);
    expect(result.vatAmount).toBe(round2(21 + 0.9));
    expect(result.total).toBe(round2(110 + 21.9));
  });

  it('handles empty line items', () => {
    const result = calculateVatTotals([], 21, true);
    expect(result.total).toBe(0);
    expect(result.subtotal).toBe(0);
    expect(result.vatAmount).toBe(0);
  });

  it('handles 0% VAT rate', () => {
    const items: InvoiceLineItem[] = [
      { description: 'Test', quantity: 1, unit_price: 100 },
    ];
    const result = calculateVatTotals(items, 0, true);
    expect(result.total).toBe(100);
    expect(result.subtotal).toBe(100);
    expect(result.vatAmount).toBe(0);
  });
});

describe('calculateSplitShares', () => {
  it('splits evenly by 2', () => {
    const { firstPlayerTotal, otherPlayerShare } = calculateSplitShares(100, 2);
    expect(firstPlayerTotal).toBe(50);
    expect(otherPlayerShare).toBe(50);
  });

  it('splits by 3 with remainder to first player', () => {
    const { firstPlayerTotal, otherPlayerShare } = calculateSplitShares(100, 3);
    expect(otherPlayerShare).toBe(33.33);
    // First player absorbs remainder: 100 - 33.33*3 = 0.01
    expect(firstPlayerTotal).toBe(33.34);
    // Total check: first + 2 others = 100
    expect(round2(firstPlayerTotal + otherPlayerShare * 2)).toBe(100);
  });

  it('splits by 4', () => {
    const { firstPlayerTotal, otherPlayerShare } = calculateSplitShares(100, 4);
    expect(otherPlayerShare).toBe(25);
    expect(firstPlayerTotal).toBe(25);
  });

  it('handles small amount split by 3', () => {
    const { firstPlayerTotal, otherPlayerShare } = calculateSplitShares(10, 3);
    expect(otherPlayerShare).toBe(3.33);
    expect(firstPlayerTotal).toBe(3.34);
    expect(round2(firstPlayerTotal + otherPlayerShare * 2)).toBe(10);
  });

  it('handles single player (no split)', () => {
    const { firstPlayerTotal, otherPlayerShare } = calculateSplitShares(100, 1);
    expect(firstPlayerTotal).toBe(100);
    expect(otherPlayerShare).toBe(100);
  });
});
