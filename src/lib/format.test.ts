import { describe, it, expect } from 'vitest';
import { formatCurrency, formatCurrencyMaybe, formatDate } from './format';

describe('formatCurrency', () => {
  it('renders English EUR as €X.XX (default locale in tests)', () => {
    expect(formatCurrency(100)).toBe('€100.00');
    expect(formatCurrency(45.5)).toBe('€45.50');
    expect(formatCurrency(0)).toBe('€0.00');
  });
  it('is locale-aware: Dutch uses comma decimals', () => {
    expect(formatCurrency(100, 'en')).toBe('€100.00');
    expect(formatCurrency(50, 'nl')).toBe('€ 50,00');
    expect(formatCurrency(1234.5, 'nl')).toBe('€ 1.234,50');
  });
  it('rounds to two decimals', () => {
    expect(formatCurrency(45.999, 'en')).toBe('€46.00');
    expect(formatCurrency(45.994, 'en')).toBe('€45.99');
  });
  it('falls back to €0.00 for non-finite input', () => {
    expect(formatCurrency(NaN, 'en')).toBe('€0.00');
    expect(formatCurrency(Infinity, 'en')).toBe('€0.00');
  });
  it('matches the legacy formatPrice it replaces (English default)', async () => {
    const { formatPrice } = await import('./pricing');
    for (const n of [0, 5, 12.3, 99.995, 1000]) {
      expect(formatPrice(n)).toBe(formatCurrency(n));
    }
  });
});

describe('formatCurrencyMaybe', () => {
  it('renders a value when present', () => {
    expect(formatCurrencyMaybe(12.5)).toBe('€12.50');
  });
  it('returns the fallback for null/undefined/non-finite', () => {
    expect(formatCurrencyMaybe(null)).toBe('—');
    expect(formatCurrencyMaybe(undefined)).toBe('—');
    expect(formatCurrencyMaybe(NaN)).toBe('—');
    expect(formatCurrencyMaybe(null, 'n/a')).toBe('n/a');
  });
});

describe('formatDate', () => {
  it('formats with the default pattern', () => {
    expect(formatDate('2026-06-05T10:00:00Z')).toBe('5 Jun 2026');
  });
  it('accepts a custom pattern', () => {
    expect(formatDate('2026-06-05T10:00:00Z', 'dd-MM-yyyy')).toBe('05-06-2026');
  });
  it('returns empty string for missing/invalid input', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDate('')).toBe('');
    expect(formatDate('not-a-date')).toBe('');
  });
});
