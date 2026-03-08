import { describe, it, expect } from 'vitest';
import type { CycleSettings, ScoringWeights } from './cycles';
import { DEFAULT_SCORING_WEIGHTS } from './cycles';

describe('CycleSettings type and defaults', () => {
  it('DEFAULT_SCORING_WEIGHTS sums to 100', () => {
    const sum = Object.values(DEFAULT_SCORING_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBe(100);
  });

  it('DEFAULT_SCORING_WEIGHTS has all required keys', () => {
    const keys: (keyof ScoringWeights)[] = [
      'time_match', 'preferred_trainer', 'level_compatible',
      'priority_bonus', 'capacity_available', 'sessions_per_week',
    ];
    keys.forEach(k => expect(DEFAULT_SCORING_WEIGHTS).toHaveProperty(k));
  });

  it('CycleSettings supports payment_timing values', () => {
    const settings: CycleSettings = {
      payment_timing: 'upfront',
    };
    expect(settings.payment_timing).toBe('upfront');

    const invoiceSettings: CycleSettings = {
      payment_timing: 'invoice_after_weeks',
      invoice_delay_weeks: 2,
    };
    expect(invoiceSettings.payment_timing).toBe('invoice_after_weeks');
    expect(invoiceSettings.invoice_delay_weeks).toBe(2);

    const manualSettings: CycleSettings = {
      payment_timing: 'manual',
    };
    expect(manualSettings.payment_timing).toBe('manual');
  });

  it('backwards compatibility: mark_as_paid maps to manual', () => {
    // Old data may have mark_as_paid: true without payment_timing
    const legacySettings: CycleSettings = {
      mark_as_paid: true,
    };

    // The CycleForm maps this: if mark_as_paid && !payment_timing → 'manual'
    const effectiveTiming = legacySettings.payment_timing ||
      (legacySettings.mark_as_paid ? 'manual' : 'upfront');
    expect(effectiveTiming).toBe('manual');
  });

  it('new settings without mark_as_paid default to upfront', () => {
    const settings: CycleSettings = {};
    const effectiveTiming = settings.payment_timing ||
      (settings.mark_as_paid ? 'manual' : 'upfront');
    expect(effectiveTiming).toBe('upfront');
  });

  it('extra_costs array works correctly', () => {
    const settings: CycleSettings = {
      extra_costs: [
        { description: 'Ball costs', price: 5 },
        { description: 'Court rental', price: 10 },
      ],
    };
    expect(settings.extra_costs).toHaveLength(2);
    expect(settings.extra_costs![0].price).toBe(5);
  });
});
