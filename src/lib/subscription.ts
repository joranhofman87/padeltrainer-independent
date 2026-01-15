// Subscription tier configuration
export type SubscriptionTier = 'starter' | 'professional' | 'academy';

export interface SubscriptionInfo {
  isSubscribed: boolean;
  tier: SubscriptionTier;
  productId: string | null;
  subscriptionEnd: string | null;
}

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

export const STARTER_TIER = {
  name: 'Starter',
  platformFeePercent: 10,
  maxLessons: 3,
  monthlyPrice: 0,
  yearlyPrice: 0,
};

export function getPlatformFeePercent(tier: SubscriptionTier): number {
  if (tier === 'starter') return STARTER_TIER.platformFeePercent;
  return SUBSCRIPTION_TIERS[tier].platformFeePercent;
}

export function getTierFromProductId(productId: string | null): SubscriptionTier {
  if (!productId) return 'starter';
  
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
  
  return 'starter';
}

export function canCreateMoreLessons(tier: SubscriptionTier, currentLessonCount: number): boolean {
  if (tier === 'starter') {
    return currentLessonCount < STARTER_TIER.maxLessons;
  }
  return true; // Professional and Academy have unlimited lessons
}
