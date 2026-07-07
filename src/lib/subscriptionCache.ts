/**
 * Last-known-good subscription cache.
 *
 * A transient `check-stripe-subscription` failure (mobile network flake, edge
 * cold start, 5xx) used to be indistinguishable from "expired": useAuth's
 * fallback set isSubscribed/isInTrial false, TrainerLayout hard-redirected to
 * the subscription page and the sidebar went dead — stranding PAYING trainers
 * until a lucky reload. The check now retries, and on persistent failure falls
 * back to (1) the in-memory state from this session, else (2) this cache from a
 * recent successful check, else (3) the old fail-closed state (brand-new device
 * with no history — no entitlement granted that was never observed).
 *
 * Only SUCCESSFUL check results are written here, and reads are bounded by
 * MAX_AGE_MS so a genuinely lapsed subscription can outlive its lapse by at
 * most that window — and only while the checker keeps failing.
 */
import type { SubscriptionInfo } from '@/lib/subscription';
import { logger } from '@/lib/logger';

const KEY = 'pt_subscription_cache_v1';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface CachedSubscription {
  userId: string;
  at: number;
  sub: SubscriptionInfo;
}

export function writeCachedSubscription(userId: string, sub: SubscriptionInfo): void {
  try {
    const entry: CachedSubscription = { userId, at: Date.now(), sub };
    localStorage.setItem(KEY, JSON.stringify(entry));
  } catch {
    // Quota/private-mode failures must never break the auth flow.
  }
}

export function readCachedSubscription(userId: string): SubscriptionInfo | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CachedSubscription;
    if (entry.userId !== userId) return null;
    if (typeof entry.at !== 'number' || Date.now() - entry.at > MAX_AGE_MS) return null;
    if (typeof entry.sub?.isSubscribed !== 'boolean') return null;
    return entry.sub;
  } catch {
    return null;
  }
}

/** For sign-out: a cached entitlement must not leak to the next account on this device. */
export function clearCachedSubscription(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

export function logSubscriptionFallback(source: 'memory' | 'cache' | 'fail_closed'): void {
  logger.warn('Subscription check failed after retries — using fallback', {
    component: 'useAuth',
    fallback: source,
  });
}
