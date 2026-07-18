/**
 * Unified PostHog tracking helper.
 * All events silently no-op in non-production environments because
 * posthog-js is only lazily loaded + initialized on production domains.
 */
import { withPostHog } from '@/lib/posthog';
import { buildPersonTrackingId, sanitizeTrackingProperties } from '@/lib/trackingPrivacy';

/** Identify the authenticated user by their PERSON UID (`person:<profile.id>`), never the
 *  auth UID or PII. Traits are sanitized — only non-personal keys survive. */
export function identifyUser(
  personUid: string,
  traits?: Record<string, unknown>
) {
  withPostHog((ph) => ph.identify(buildPersonTrackingId(personUid), sanitizeTrackingProperties(traits)));
}

/** Reset the PostHog identity on logout. */
export function resetUser() {
  withPostHog((ph) => ph.reset());
}

/** Capture a custom event with optional properties. Never throws. */
export function trackEvent(
  event: string,
  properties?: Record<string, unknown>
) {
  withPostHog((ph) => ph.capture(event, sanitizeTrackingProperties(properties)));
}
