// Subscription-check resilience (trainer-audit batch 4): a transient
// check-stripe-subscription failure must not read as "expired" — useAuth now
// retries and falls back to in-memory state, then to this last-known-good cache,
// and only fails closed on a device that never saw an entitlement.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  writeCachedSubscription,
  readCachedSubscription,
  clearCachedSubscription,
} from '@/lib/subscriptionCache';
import type { SubscriptionInfo } from '@/lib/subscription';

const sub = (over: Partial<SubscriptionInfo> = {}): SubscriptionInfo => ({
  isSubscribed: true,
  tier: 'professional',
  subscriptionEnd: '2027-01-01T00:00:00Z',
  trialEndsAt: null,
  isInTrial: false,
  isPublic: true,
  managedByAcademy: false,
  academyName: null,
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('subscriptionCache', () => {
  it('roundtrips the last successful check for the same user', () => {
    writeCachedSubscription('user-1', sub());
    expect(readCachedSubscription('user-1')?.isSubscribed).toBe(true);
    expect(readCachedSubscription('user-1')?.tier).toBe('professional');
  });

  it('never hands one user another user’s entitlement', () => {
    writeCachedSubscription('user-1', sub());
    expect(readCachedSubscription('user-2')).toBeNull();
  });

  it('expires after 24h — a lapsed subscription cannot ride the cache forever', () => {
    writeCachedSubscription('user-1', sub());
    vi.advanceTimersByTime(23 * 60 * 60 * 1000);
    expect(readCachedSubscription('user-1')).not.toBeNull();
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);
    expect(readCachedSubscription('user-1')).toBeNull();
  });

  it('clearCachedSubscription wipes it (sign-out path)', () => {
    writeCachedSubscription('user-1', sub());
    clearCachedSubscription();
    expect(readCachedSubscription('user-1')).toBeNull();
  });

  it('tolerates corrupt storage', () => {
    localStorage.setItem('pt_subscription_cache_v1', '{not json');
    expect(readCachedSubscription('user-1')).toBeNull();
  });
});
