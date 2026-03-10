import { describe, it, expect } from 'vitest';
import { canBeVisible, TRIAL_DURATION_DAYS, SUBSCRIPTION_TIERS, STARTER_TIER } from './subscription';
import type { SubscriptionInfo } from './subscription';

describe('subscription', () => {
  it('TRIAL_DURATION_DAYS is 7', () => {
    expect(TRIAL_DURATION_DAYS).toBe(7);
  });

  it('SUBSCRIPTION_TIERS has professional and academy', () => {
    expect(SUBSCRIPTION_TIERS.professional).toBeDefined();
    expect(SUBSCRIPTION_TIERS.academy).toBeDefined();
    expect(SUBSCRIPTION_TIERS.professional.monthlyPrice).toBeGreaterThan(0);
    expect(SUBSCRIPTION_TIERS.academy.monthlyPrice).toBeGreaterThan(SUBSCRIPTION_TIERS.professional.monthlyPrice);
  });

  it('STARTER_TIER is cheaper than professional', () => {
    expect(STARTER_TIER.monthlyPrice).toBeLessThan(SUBSCRIPTION_TIERS.professional.monthlyPrice);
  });

  it('yearly prices are discounted vs 12x monthly', () => {
    expect(SUBSCRIPTION_TIERS.professional.yearlyPrice).toBeLessThan(SUBSCRIPTION_TIERS.professional.monthlyPrice * 12);
    expect(SUBSCRIPTION_TIERS.academy.yearlyPrice).toBeLessThan(SUBSCRIPTION_TIERS.academy.monthlyPrice * 12);
    expect(STARTER_TIER.yearlyPrice).toBeLessThan(STARTER_TIER.monthlyPrice * 12);
  });

  describe('canBeVisible', () => {
    it('returns true when subscribed', () => {
      const sub: SubscriptionInfo = {
        isSubscribed: true,
        tier: 'professional',
        subscriptionEnd: null,
        trialEndsAt: null,
        isInTrial: false,
        isPublic: true,
      };
      expect(canBeVisible(sub)).toBe(true);
    });

    it('returns false when in trial even if subscribed flag is true', () => {
      const sub: SubscriptionInfo = {
        isSubscribed: true,
        tier: 'trial',
        subscriptionEnd: null,
        trialEndsAt: new Date(Date.now() + 86400000).toISOString(),
        isInTrial: true,
        isPublic: false,
      };
      expect(canBeVisible(sub)).toBe(false);
    });

    it('returns false when only in trial (not subscribed)', () => {
      const sub: SubscriptionInfo = {
        isSubscribed: false,
        tier: 'trial',
        subscriptionEnd: null,
        trialEndsAt: new Date(Date.now() + 86400000).toISOString(),
        isInTrial: true,
        isPublic: false,
      };
      expect(canBeVisible(sub)).toBe(false);
    });

    it('returns false when no subscription', () => {
      const sub: SubscriptionInfo = {
        isSubscribed: false,
        tier: 'trial',
        subscriptionEnd: null,
        trialEndsAt: null,
        isInTrial: false,
        isPublic: false,
      };
      expect(canBeVisible(sub)).toBe(false);
    });
  });
});
