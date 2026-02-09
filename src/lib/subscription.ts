// Subscription tier configuration
export type SubscriptionTier = 'trial' | 'professional' | 'academy';

export interface SubscriptionInfo {
  isSubscribed: boolean;
  tier: SubscriptionTier;
  subscriptionEnd: string | null;
  trialEndsAt: string | null;
  isInTrial: boolean;
  isPublic: boolean;
}

// Trial configuration
export const TRIAL_DURATION_DAYS = 7;

// Subscription tier configuration (database-driven)
export const SUBSCRIPTION_TIERS = {
  professional: {
    name: 'Professional',
    monthlyPrice: 39,
    yearlyPrice: 374,
  },
  academy: {
    name: 'Academy',
    monthlyPrice: 99,
    yearlyPrice: 950,
  },
} as const;

export const STARTER_TIER = {
  name: 'Starter',
  monthlyPrice: 10,
  yearlyPrice: 96,
};

// Re-export shared utilities
export { getTrialDaysRemaining, isDateExpired } from './sharedSubscription';

export function canBeVisible(subscription: SubscriptionInfo): boolean {
  // Trainer can be visible only with an active paid subscription (trial alone is not enough)
  return subscription.isSubscribed;
}
