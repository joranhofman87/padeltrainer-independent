/**
 * Shared subscription utilities used across Trainer, Club, and Academy roles.
 * This module provides consistent subscription handling patterns.
 */

/**
 * Unified subscription status type
 */
export type SubscriptionStatus = 'active' | 'trialing' | 'expired' | 'inactive';

/**
 * Base subscription info interface used across all roles
 */
export interface BaseSubscriptionInfo {
  isSubscribed: boolean;
  isTrial: boolean;
  trialEnd: string | null;
  trialExpired: boolean;
  subscriptionEnd: string | null;
}

/**
 * Calculate days remaining until a given date
 * @param endDate - ISO date string for the end date
 * @returns Number of days remaining (0 if expired or no date)
 */
export function getTrialDaysRemaining(endDate: string | null): number {
  if (!endDate) return 0;
  const now = new Date();
  const end = new Date(endDate);
  const diff = end.getTime() - now.getTime();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

/**
 * Check if a date has passed
 * @param dateStr - ISO date string to check
 * @returns true if the date is in the past
 */
export function isDateExpired(dateStr: string | null): boolean {
  if (!dateStr) return true;
  return new Date(dateStr) < new Date();
}

/**
 * Determine if subscription allows access to features
 * @param subscription - The subscription info object
 * @returns true if user has valid subscription or active trial
 */
export function hasActiveAccess(subscription: BaseSubscriptionInfo): boolean {
  return subscription.isSubscribed || (subscription.isTrial && !subscription.trialExpired);
}

/**
 * Get a human-readable subscription status
 * @param subscription - The subscription info object
 * @returns Status string for display
 */
export function getSubscriptionStatus(subscription: BaseSubscriptionInfo): SubscriptionStatus {
  if (subscription.isSubscribed) return 'active';
  if (subscription.isTrial && !subscription.trialExpired) return 'trialing';
  if (subscription.trialExpired) return 'expired';
  return 'inactive';
}

/**
 * Format date for display
 * @param dateStr - ISO date string
 * @param locale - Locale for formatting (default: nl-NL)
 * @returns Formatted date string
 */
export function formatSubscriptionDate(dateStr: string | null, locale = 'nl-NL'): string {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

// Common trial durations
export const TRIAL_DURATIONS = {
  trainer: 7,
  club: 14,
  academy: 14,
} as const;

// Common subscription prices (in EUR)
export const SUBSCRIPTION_PRICES = {
  trainer: {
    starter: { monthly: 10, yearly: 96 },
    professional: { monthly: 39, yearly: 374 },
    academy: { monthly: 99, yearly: 950 },
  },
  club: { monthly: 199, yearly: 2388 },
  academy: { monthly: 199, yearly: 2388 },
} as const;
