import { describe, it, expect } from 'vitest';
import {
  getTrialDaysRemaining,
  isDateExpired,
  hasActiveAccess,
  getSubscriptionStatus,
  formatSubscriptionDate,
  TRIAL_DURATIONS,
  SUBSCRIPTION_PRICES,
} from './sharedSubscription';
import type { BaseSubscriptionInfo } from './sharedSubscription';

describe('getTrialDaysRemaining', () => {
  it('returns 0 for null date', () => {
    expect(getTrialDaysRemaining(null)).toBe(0);
  });

  it('returns 0 for past date', () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    expect(getTrialDaysRemaining(past)).toBe(0);
  });

  it('returns positive days for future date', () => {
    const future = new Date(Date.now() + 3 * 86400000).toISOString();
    const days = getTrialDaysRemaining(future);
    expect(days).toBeGreaterThanOrEqual(2);
    expect(days).toBeLessThanOrEqual(4);
  });

  it('returns 1 for date less than 24h away', () => {
    const soon = new Date(Date.now() + 12 * 3600000).toISOString();
    expect(getTrialDaysRemaining(soon)).toBe(1);
  });
});

describe('isDateExpired', () => {
  it('returns true for null', () => {
    expect(isDateExpired(null)).toBe(true);
  });

  it('returns true for past date', () => {
    expect(isDateExpired(new Date(Date.now() - 1000).toISOString())).toBe(true);
  });

  it('returns false for future date', () => {
    expect(isDateExpired(new Date(Date.now() + 86400000).toISOString())).toBe(false);
  });
});

describe('hasActiveAccess', () => {
  it('returns true when subscribed', () => {
    const sub: BaseSubscriptionInfo = {
      isSubscribed: true,
      isTrial: false,
      trialEnd: null,
      trialExpired: false,
      subscriptionEnd: null,
    };
    expect(hasActiveAccess(sub)).toBe(true);
  });

  it('returns true when in active trial', () => {
    const sub: BaseSubscriptionInfo = {
      isSubscribed: false,
      isTrial: true,
      trialEnd: new Date(Date.now() + 86400000).toISOString(),
      trialExpired: false,
      subscriptionEnd: null,
    };
    expect(hasActiveAccess(sub)).toBe(true);
  });

  it('returns false when trial expired and not subscribed', () => {
    const sub: BaseSubscriptionInfo = {
      isSubscribed: false,
      isTrial: true,
      trialEnd: new Date(Date.now() - 86400000).toISOString(),
      trialExpired: true,
      subscriptionEnd: null,
    };
    expect(hasActiveAccess(sub)).toBe(false);
  });
});

describe('getSubscriptionStatus', () => {
  it('returns active for subscribed', () => {
    expect(getSubscriptionStatus({ isSubscribed: true, isTrial: false, trialEnd: null, trialExpired: false, subscriptionEnd: null })).toBe('active');
  });

  it('returns trialing for active trial', () => {
    expect(getSubscriptionStatus({ isSubscribed: false, isTrial: true, trialEnd: null, trialExpired: false, subscriptionEnd: null })).toBe('trialing');
  });

  it('returns expired for expired trial', () => {
    expect(getSubscriptionStatus({ isSubscribed: false, isTrial: false, trialEnd: null, trialExpired: true, subscriptionEnd: null })).toBe('expired');
  });

  it('returns inactive when nothing', () => {
    expect(getSubscriptionStatus({ isSubscribed: false, isTrial: false, trialEnd: null, trialExpired: false, subscriptionEnd: null })).toBe('inactive');
  });
});

describe('formatSubscriptionDate', () => {
  it('returns dash for null', () => {
    expect(formatSubscriptionDate(null)).toBe('-');
  });

  it('formats a date string', () => {
    const result = formatSubscriptionDate('2025-06-15T00:00:00Z');
    expect(result).toContain('2025');
  });
});

describe('constants', () => {
  it('TRIAL_DURATIONS are positive', () => {
    expect(TRIAL_DURATIONS.trainer).toBeGreaterThan(0);
    expect(TRIAL_DURATIONS.club).toBeGreaterThan(0);
    expect(TRIAL_DURATIONS.academy).toBeGreaterThan(0);
  });

  it('SUBSCRIPTION_PRICES yearly is cheaper than 12x monthly', () => {
    expect(SUBSCRIPTION_PRICES.trainer.professional.yearly).toBeLessThan(SUBSCRIPTION_PRICES.trainer.professional.monthly * 12);
    expect(SUBSCRIPTION_PRICES.club.yearly).toBeLessThan(SUBSCRIPTION_PRICES.club.monthly * 12);
  });
});
