/**
 * Unified PostHog tracking helper.
 * All events silently no-op in non-production environments
 * because posthog.init() is only called on production domains.
 */
import { posthog } from '@/lib/posthog';

/** Identify the authenticated user and link anonymous browsing history. */
export function identifyUser(
  userId: string,
  traits?: Record<string, string | number | boolean | null>
) {
  posthog.identify(userId, traits);
}

/** Reset the PostHog identity on logout. */
export function resetUser() {
  posthog.reset();
}

/** Capture a custom event with optional properties. */
export function trackEvent(
  event: string,
  properties?: Record<string, string | number | boolean | null | undefined>
) {
  posthog.capture(event, properties);
}
