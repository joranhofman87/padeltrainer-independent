/**
 * Analytics helper for trainer onboarding funnel events.
 * Uses window.gtag if available (respects cookie consent),
 * falls back to console.log.
 */

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
  const eventData = {
    event_category: 'trainer_onboarding',
    ...params,
  };

  // Google Analytics (if consent given)
  if (typeof window !== 'undefined' && window.gtag) {
    window.gtag('event', event, eventData);
  }

  // Dev logging
  if (import.meta.env.DEV) {
    console.log(`[Onboarding] ${event}`, eventData);
  }
}
