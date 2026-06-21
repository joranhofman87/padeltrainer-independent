import { describe, it, expect } from 'vitest';
import {
  computeRegistrationCharge,
  type RegistrationPricingCycle,
} from '../../supabase/functions/_shared/registration-pricing.ts';

// A representative registration cycle: 2 offered lesson types, a duration
// allow-list, one package, prices VAT-inclusive. Academy default VAT = 9%.
const cycle = (): RegistrationPricingCycle => ({
  type: 'registration',
  total_price: null,
  price_per_session: 20,
  price_table: [
    { description: 'Private', price: 50 },
    { description: 'Duo', price: 30, vat_rate: 21 },
  ],
  start_date: '2026-01-05',
  end_date: '2026-03-30', // ~12 weeks
  settings: {
    lesson_types: ['private', 'duo'],
    duration_options: [10, 12],
    cyclus_options: [
      { label: 'Premium', number_of_sessions: 10, number_of_weeks: 10, price_per_session: 25, total_price: 250 },
    ],
    prices_include_vat: true,
  },
});
const VAT = 9;

describe('computeRegistrationCharge — happy path', () => {
  it('prices a single offered lesson type by weeks (server price_table)', () => {
    const c = computeRegistrationCharge(cycle(), VAT, { lessonTypes: ['private'], durationWeeks: 10 });
    expect(c).not.toBeNull();
    expect(c!.lineItems).toHaveLength(1);
    expect(c!.lineItems[0].unit_price).toBe(500); // 50 × 10
    expect(c!.total).toBe(500);
    // VAT-inclusive 9%: subtotal + vat == total
    expect(c!.subtotal + c!.vatAmount).toBeCloseTo(500, 2);
  });

  it('uses the server package total_price, ignoring per-lesson selections', () => {
    const c = computeRegistrationCharge(cycle(), VAT, {
      lessonTypes: ['private'],
      cyclusOptionLabel: 'Premium',
    });
    expect(c!.lineItems).toHaveLength(1);
    expect(c!.lineItems[0].description).toBe('Premium');
    expect(c!.total).toBe(250); // server total_price, not the €500 per-lesson path
  });
});

describe('computeRegistrationCharge — SECURITY: client cannot underpay', () => {
  it('ignores a lesson type the cycle does not offer (no fallback to a cheaper price)', () => {
    // "kids" is NOT in settings.lesson_types → must be skipped entirely.
    const c = computeRegistrationCharge(cycle(), VAT, { lessonTypes: ['kids'], durationWeeks: 10 });
    expect(c).toBeNull(); // nothing payable, rather than billing price_per_session
  });

  it('rejects a duration not in the allow-list (no short-duration discount)', () => {
    const c = computeRegistrationCharge(cycle(), VAT, { lessonTypes: ['private'], durationWeeks: 1 });
    expect(c).toBeNull(); // 1 week is not in duration_options [10, 12]
  });

  it('only the cycle-config package price is used — there is no client price input to forge', () => {
    // selections carry only the LABEL; the price comes from settings.cyclus_options.
    const c = computeRegistrationCharge(cycle(), VAT, { lessonTypes: [], cyclusOptionLabel: 'Premium' });
    expect(c!.total).toBe(250);
  });

  it('falls through (does not crash/underprice) on a non-existent package label', () => {
    const c = computeRegistrationCharge(cycle(), VAT, {
      lessonTypes: ['private'],
      cyclusOptionLabel: 'DefinitelyNotReal',
      durationWeeks: 10,
    });
    expect(c!.total).toBe(500); // priced per-lesson, package ignored
  });

  it('rejects out-of-bounds numeric inputs (huge / negative weeks)', () => {
    expect(computeRegistrationCharge(cycle(), VAT, { lessonTypes: ['private'], durationWeeks: 99999 })).toBeNull();
    expect(computeRegistrationCharge(cycle(), VAT, { lessonTypes: ['private'], durationWeeks: -5 })).toBeNull();
  });

  it('returns null for an empty / all-invalid selection rather than a €0 charge', () => {
    expect(computeRegistrationCharge(cycle(), VAT, { lessonTypes: [] })).toBeNull();
  });
});

describe('computeRegistrationCharge — VAT', () => {
  it('single rate (inclusive): subtotal + vat reconciles to total', () => {
    const c = computeRegistrationCharge(cycle(), VAT, { lessonTypes: ['private'], durationWeeks: 10 });
    expect(c!.vatRate).toBe(9);
    expect(c!.subtotal + c!.vatAmount).toBeCloseTo(c!.total, 2);
  });

  it('multi-rate: produces a vat_breakdown keyed by rate', () => {
    // private → default 9%, duo → 21% (per price_table row)
    const c = computeRegistrationCharge(cycle(), VAT, { lessonTypes: ['private', 'duo'], durationWeeks: 10 });
    expect(c!.lineItems).toHaveLength(2);
    expect(Object.keys(c!.vatBreakdown).sort()).toEqual(['21', '9']);
    expect(c!.subtotal + c!.vatAmount).toBeCloseTo(c!.total, 2);
  });
});
