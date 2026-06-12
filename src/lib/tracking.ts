/**
 * Unified PostHog tracking helper.
 * All events silently no-op in non-production environments because
 * posthog-js is only lazily loaded + initialized on production domains.
 */
import { withPostHog } from '@/lib/posthog';

/** Identify the authenticated user and link anonymous browsing history. */
export function identifyUser(
  userId: string,
  traits?: Record<string, string | number | boolean | null>
) {
  withPostHog((ph) => ph.identify(userId, traits));
}

/** Reset the PostHog identity on logout. */
export function resetUser() {
  withPostHog((ph) => ph.reset());
}

/** Capture a custom event with optional properties. Never throws. */
export function trackEvent(
  event: string,
  properties?: Record<string, string | number | boolean | null | undefined>
) {
  withPostHog((ph) => ph.capture(event, properties));
}
