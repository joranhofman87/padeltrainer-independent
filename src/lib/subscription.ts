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
export const TRIAL_PLATFORM_FEE_PERCENT = 10;

export const SUBSCRIPTION_TIERS = {
  professional: {
    name: 'Professional',
    priceIdMonthly: 'price_1Spz9VPxAlHS6UZH9wmgdECd',
    priceIdYearly: 'price_1Spz9uPxAlHS6UZHMaZfUTBY',
    productIdMonthly: 'prod_TnaKMqklQL0csZ',
    productIdYearly: 'prod_TnaK7n69g3z1go',
    platformFeePercent: 5,
    monthlyPrice: 29,
    yearlyPrice: 278,
  },
  academy: {
    name: 'Academy',
    priceIdMonthly: 'price_1SpzA8PxAlHS6UZHKsoY94qK',
    priceIdYearly: 'price_1SpzAdPxAlHS6UZHKjhjq8Ey',
    productIdMonthly: 'prod_TnaKlteqteiFWb',
    productIdYearly: 'prod_TnaLKqo3OnQCOd',
    platformFeePercent: 2.5,
    monthlyPrice: 79,
    yearlyPrice: 758,
  },
} as const;

export const TRIAL_TIER = {
  name: 'Trial',
  platformFeePercent: TRIAL_PLATFORM_FEE_PERCENT,
  maxLessons: 3,
  monthlyPrice: 0,
  yearlyPrice: 0,
};

export function getPlatformFeePercent(tier: SubscriptionTier): number {
  if (tier === 'trial') return TRIAL_TIER.platformFeePercent;
  return SUBSCRIPTION_TIERS[tier].platformFeePercent;
}

export function getTierFromProductId(productId: string | null): SubscriptionTier {
  if (!productId) return 'trial';
  
  // Check Professional tier
  if (productId === SUBSCRIPTION_TIERS.professional.productIdMonthly ||
      productId === SUBSCRIPTION_TIERS.professional.productIdYearly) {
    return 'professional';
  }
  
  // Check Academy tier
  if (productId === SUBSCRIPTION_TIERS.academy.productIdMonthly ||
      productId === SUBSCRIPTION_TIERS.academy.productIdYearly) {
    return 'academy';
  }
  
  return 'trial';
}

export function canCreateMoreLessons(tier: SubscriptionTier, currentLessonCount: number): boolean {
  if (tier === 'trial') {
    return currentLessonCount < TRIAL_TIER.maxLessons;
  }
  return true; // Professional and Academy have unlimited lessons
}

export function isTrialExpired(trialEndsAt: string | null): boolean {
  if (!trialEndsAt) return true;
  return new Date(trialEndsAt) < new Date();
}

export function getTrialDaysRemaining(trialEndsAt: string | null): number {
  if (!trialEndsAt) return 0;
  const now = new Date();
  const end = new Date(trialEndsAt);
  const diff = end.getTime() - now.getTime();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

export function canBeVisible(subscription: SubscriptionInfo): boolean {
  // Trainer can be visible if they have an active subscription OR are still in trial
  return subscription.isSubscribed || subscription.isInTrial;
}
