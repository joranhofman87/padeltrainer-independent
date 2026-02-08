// Subscription tier configuration
export type SubscriptionTier = 'trial' | 'professional' | 'academy';

export interface SubscriptionInfo {
  isSubscribed: boolean;
  tier: SubscriptionTier;
  productId: string | null;
  subscriptionEnd: string | null;
  trialEndsAt: string | null;
  isInTrial: boolean;
  isPublic: boolean;
}

// Trial configuration
export const TRIAL_DURATION_DAYS = 7;

// Subscription tier configuration (database-driven, no Stripe IDs)
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
  maxLessons: 3,
  monthlyPrice: 10,
  yearlyPrice: 96,
};

/**
 * @deprecated Tier is now determined directly from database subscription_tier field.
 * This function is kept for backward compatibility but should not be used for new code.
 */
export function getTierFromProductId(productId: string | null): SubscriptionTier {
  // With Mollie, tier comes directly from database - no product ID mapping needed
  return 'trial';
}

export function canCreateMoreLessons(tier: SubscriptionTier, currentLessonCount: number): boolean {
  if (tier === 'trial') {
    return currentLessonCount < STARTER_TIER.maxLessons;
  }
  return true; // Professional and Academy have unlimited lessons
}

// Re-export shared utilities
export { getTrialDaysRemaining, isDateExpired } from './sharedSubscription';

export function canBeVisible(subscription: SubscriptionInfo): boolean {
  // Trainer can be visible only with an active paid subscription (trial alone is not enough)
  return subscription.isSubscribed;
}
