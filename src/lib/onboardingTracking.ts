/**
 * Analytics helper for trainer onboarding funnel events.
 * Uses PostHog for production tracking.
 */
import { trackEvent } from '@/lib/tracking';

type OnboardingEvent =
  | 'onboarding_started'
  | 'step1_goal_selected'
  | 'profile_mvp_completed'
  | 'lesson_created'
  | 'slots_created'
  | 'onboarding_completed'
  | 'preview_opened'
  | 'dashboard_opened'
  | 'publish_toggled_on'
  | 'publish_toggled_off'
  | 'icd_card_completed';

export function trackOnboardingEvent(
  event: OnboardingEvent,
  params?: Record<string, string | number | boolean>
) {
  trackEvent(event, {
    event_category: 'trainer_onboarding',
    ...params,
  });
}
