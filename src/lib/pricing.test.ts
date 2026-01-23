import { describe, it, expect } from 'vitest';
import {
  calculateSlotPrice,
  calculateSlotPriceFromTimes,
  calculateCyclusTotal,
  applyDiscount,
  formatPrice,
  getSlotDurationMinutes,
} from './pricing';

describe('calculateSlotPrice', () => {
  it('calculates price for 60 minutes at €60/hour', () => {
    expect(calculateSlotPrice(60, 60)).toBe(60);
  });

  it('calculates price for 30 minutes at €60/hour', () => {
    expect(calculateSlotPrice(60, 30)).toBe(30);
  });

  it('calculates price for 90 minutes at €40/hour', () => {
    expect(calculateSlotPrice(40, 90)).toBe(60);
  });

  it('returns 0 for 0 duration', () => {
    expect(calculateSlotPrice(60, 0)).toBe(0);
  });

  it('handles decimal hourly rates', () => {
    expect(calculateSlotPrice(45.50, 60)).toBeCloseTo(45.50);
  });
});

describe('calculateSlotPriceFromTimes', () => {
  it('calculates price from ISO date strings', () => {
    const start = '2024-01-15T10:00:00Z';
    const end = '2024-01-15T11:00:00Z';
    expect(calculateSlotPriceFromTimes(60, start, end)).toBe(60);
  });

  it('calculates price for 45-minute slot', () => {
    const start = '2024-01-15T10:00:00Z';
    const end = '2024-01-15T10:45:00Z';
    expect(calculateSlotPriceFromTimes(80, start, end)).toBe(60);
  });

  it('handles Date objects', () => {
    const start = new Date('2024-01-15T10:00:00Z');
    const end = new Date('2024-01-15T12:00:00Z');
    expect(calculateSlotPriceFromTimes(50, start, end)).toBe(100);
  });
});

describe('calculateCyclusTotal', () => {
  it('calculates total for multiple slots', () => {
    const slots = [
      { start_time: '2024-01-15T10:00:00Z', end_time: '2024-01-15T11:00:00Z' },
      { start_time: '2024-01-16T10:00:00Z', end_time: '2024-01-16T11:00:00Z' },
      { start_time: '2024-01-17T10:00:00Z', end_time: '2024-01-17T11:00:00Z' },
    ];
    expect(calculateCyclusTotal(60, slots)).toBe(180);
  });

  it('returns 0 for empty slots array', () => {
    expect(calculateCyclusTotal(60, [])).toBe(0);
  });

  it('handles slots of different durations', () => {
    const slots = [
      { start_time: '2024-01-15T10:00:00Z', end_time: '2024-01-15T11:00:00Z' }, // 60 min
      { start_time: '2024-01-16T10:00:00Z', end_time: '2024-01-16T10:30:00Z' }, // 30 min
    ];
    expect(calculateCyclusTotal(60, slots)).toBe(90);
  });
});

describe('applyDiscount', () => {
  describe('percentage discount', () => {
    it('applies 10% discount correctly', () => {
      const result = applyDiscount(100, 'percentage', 10);
      expect(result.finalAmount).toBe(90);
      expect(result.discountAmount).toBe(10);
    });

    it('applies 50% discount correctly', () => {
      const result = applyDiscount(80, 'percentage', 50);
      expect(result.finalAmount).toBe(40);
      expect(result.discountAmount).toBe(40);
    });

    it('applies 100% discount correctly', () => {
      const result = applyDiscount(100, 'percentage', 100);
      expect(result.finalAmount).toBe(0);
      expect(result.discountAmount).toBe(100);
    });
  });

  describe('fixed discount', () => {
    it('applies €20 fixed discount', () => {
      const result = applyDiscount(100, 'fixed', 20);
      expect(result.finalAmount).toBe(80);
      expect(result.discountAmount).toBe(20);
    });

    it('caps discount at total amount', () => {
      const result = applyDiscount(50, 'fixed', 100);
      expect(result.finalAmount).toBe(0);
      expect(result.discountAmount).toBe(50);
    });
  });

  describe('edge cases', () => {
    it('returns original amount for 0 discount', () => {
      const result = applyDiscount(100, 'percentage', 0);
      expect(result.finalAmount).toBe(100);
      expect(result.discountAmount).toBe(0);
    });

    it('returns original amount for negative discount', () => {
      const result = applyDiscount(100, 'percentage', -10);
      expect(result.finalAmount).toBe(100);
      expect(result.discountAmount).toBe(0);
    });

    it('handles decimal amounts', () => {
      const result = applyDiscount(99.99, 'percentage', 10);
      expect(result.finalAmount).toBeCloseTo(89.99);
      expect(result.discountAmount).toBeCloseTo(9.999);
    });
  });
});

describe('formatPrice', () => {
  it('formats whole number with euro symbol', () => {
    expect(formatPrice(100)).toBe('€100.00');
  });

  it('formats decimal with two decimal places', () => {
    expect(formatPrice(45.5)).toBe('€45.50');
  });

  it('formats zero', () => {
    expect(formatPrice(0)).toBe('€0.00');
  });

  it('rounds to two decimal places', () => {
    expect(formatPrice(45.999)).toBe('€46.00');
  });

  it('handles large amounts', () => {
    expect(formatPrice(1234.56)).toBe('€1234.56');
  });
});

describe('getSlotDurationMinutes', () => {
  it('calculates 60 minutes for 1-hour slot', () => {
    const start = '2024-01-15T10:00:00Z';
    const end = '2024-01-15T11:00:00Z';
    expect(getSlotDurationMinutes(start, end)).toBe(60);
  });

  it('calculates 90 minutes for 1.5-hour slot', () => {
    const start = '2024-01-15T10:00:00Z';
    const end = '2024-01-15T11:30:00Z';
    expect(getSlotDurationMinutes(start, end)).toBe(90);
  });

  it('handles Date objects', () => {
    const start = new Date('2024-01-15T10:00:00Z');
    const end = new Date('2024-01-15T10:45:00Z');
    expect(getSlotDurationMinutes(start, end)).toBe(45);
  });

  it('returns 0 for same start and end', () => {
    const time = '2024-01-15T10:00:00Z';
    expect(getSlotDurationMinutes(time, time)).toBe(0);
  });
});
