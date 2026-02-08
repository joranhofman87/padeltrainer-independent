

# Full-Funnel PostHog Event Tracking Plan

## Business Goal
Track every step from anonymous website visit to paid subscription, so you can identify what converting users do differently and optimize the funnel.

## The Conversion Funnel

```text
AWARENESS          CONSIDERATION         ACTIVATION              REVENUE
-----------        ---------------       ---------------         --------
Website visit      Browse trainers       Sign up                 Subscribe
Page views         View trainer profile  Email verify             (Mollie)
Pricing page       View open slots       Onboarding steps
Blog reads         View club profile     First lesson created
                   View academy          First slot published
                                         Profile published
                                         First booking (player)
                                         Payment connected
```

## Event Tracking Specification

### Phase 1: Core tracking helper + user identification

**New file: `src/lib/tracking.ts`**

A single wrapper around `posthog.capture()` and `posthog.identify()` that all pages will use. This replaces the broken `window.gtag` calls and gives you one import for everything.

Key behaviors:
- On login/signup: call `posthog.identify(user.id)` with traits (role, signup method, created date) so all prior anonymous pageviews get linked to the user
- On logout: call `posthog.reset()` to unlink the device
- All events silently no-op in non-production (leveraging existing guard)

### Phase 2: Events by funnel stage

#### Marketing / Awareness (auto-tracked by PostHog autocapture + pageviews, no code needed)
PostHog already records every pageview and click via autocapture. The referrer ($referrer, $referring_domain) is captured automatically. No changes needed here.

#### Consideration -- new events to add

| Event | Where | Properties |
|-------|-------|------------|
| `trainer_profile_viewed` | TrainerProfile.tsx | trainer_id, trainer_slug, source (direct/search) |
| `trainer_list_filtered` | Trainers.tsx | filters applied (city, specialization, etc.) |
| `open_slots_viewed` | TrainerProfile.tsx (open slots section) | trainer_id, slot_count |
| `pricing_page_viewed` | marketing/Pricing.tsx | role (trainer/player inferred from context) |
| `club_profile_viewed` | AcademyPublicProfile.tsx | club_id |

#### Signup -- new events

| Event | Where | Properties |
|-------|-------|------------|
| `signup_started` | TrainerSignup.tsx, PlayerSignup.tsx | role, method (google/email) |
| `signup_completed` | TrainerSignup.tsx, PlayerSignup.tsx | role, method |
| `signup_email_verified` | Auth.tsx (verification handler) | role |
| `login` | Auth.tsx | method (google/email) |

#### Onboarding -- migrate existing events from gtag to PostHog

| Event | Already exists | Properties |
|-------|---------------|------------|
| `onboarding_started` | Yes (broken gtag) | role |
| `step1_goal_selected` | Yes | goal |
| `profile_mvp_completed` | Yes | -- |
| `lesson_created` | Yes | -- |
| `onboarding_completed` | Yes | -- |
| `player_onboarding_completed` | New | rating_system |

#### Activation -- new events

| Event | Where | Properties |
|-------|-------|------------|
| `profile_published` | TrainerProfile.tsx (publish toggle) | trainer_id |
| `profile_unpublished` | TrainerProfile.tsx | trainer_id |
| `slot_created` | AddSlotDialog.tsx | type (individual/cyclus) |
| `payment_connected` | MollieCallback.tsx | role |
| `booking_started` | BookLesson.tsx (slot selected) | trainer_id, is_cyclus |
| `booking_completed` | BookLesson.tsx (after booking call) | trainer_id, price, is_cyclus, payment_mode |
| `booking_paid` | BookingSuccess.tsx (verified) | booking_id |

#### Revenue -- new events

| Event | Where | Properties |
|-------|-------|------------|
| `subscription_page_viewed` | TrainerSubscription.tsx | current_plan |
| `subscription_checkout_started` | TrainerSubscription.tsx | plan, billing_cycle |
| `subscription_activated` | TrainerSubscription.tsx (success param) | plan |
| `subscription_canceled` | TrainerSubscription.tsx | -- |

### Phase 3: User identification on auth

**Modified: `src/hooks/useAuth.tsx`**

When the auth state changes (user logs in or signs up), call:
```typescript
import { identifyUser, resetUser } from '@/lib/tracking';

// On login:
identifyUser(user.id, {
  email: user.email,
  role: role,
  created_at: user.created_at,
});

// On logout:
resetUser();
```

This is the most important piece -- it links all anonymous browsing behavior to the actual user once they sign up, so you can trace the full journey in PostHog.

### Phase 4: Update onboarding tracking

**Modified: `src/lib/onboardingTracking.ts`**

Replace `window.gtag` with `posthog.capture()`. The event names and structure stay the same, they just go to PostHog now.

## Files to create
- `src/lib/tracking.ts` -- unified tracking helper (identify, track, reset)

## Files to modify
- `src/lib/onboardingTracking.ts` -- switch from gtag to PostHog
- `src/hooks/useAuth.tsx` -- add identify/reset calls on auth state change
- `src/pages/TrainerSignup.tsx` -- add signup_started / signup_completed
- `src/pages/PlayerSignup.tsx` -- add signup_started / signup_completed
- `src/pages/Auth.tsx` -- add login event
- `src/pages/TrainerProfile.tsx` -- add trainer_profile_viewed
- `src/pages/Trainers.tsx` -- add trainer_list_filtered
- `src/pages/BookLesson.tsx` -- add booking_started / booking_completed
- `src/pages/BookingSuccess.tsx` -- add booking_paid
- `src/pages/TrainerSubscription.tsx` -- add subscription events
- `src/pages/TrainerOnboarding.tsx` -- add player_onboarding_completed (no change needed, already uses trackOnboardingEvent)
- `src/pages/Onboarding.tsx` -- add player_onboarding_completed
- `src/pages/marketing/Pricing.tsx` -- add pricing_page_viewed

## What you get in PostHog after this

1. **Funnels**: Build a funnel from `$pageview (homepage)` -> `signup_started` -> `signup_completed` -> `onboarding_completed` -> `subscription_checkout_started` -> `subscription_activated` to see exactly where people drop off.

2. **User paths**: See the actual page sequences that lead to conversion vs. churn.

3. **Cohort analysis**: Compare users who subscribed vs. those who didn't -- what pages did they visit? How many trainer profiles did they view? Did they complete onboarding?

4. **Attribution**: PostHog captures `$referrer` and UTM params automatically, so you can see which traffic sources produce paying users.

## Privacy note
PostHog is already configured with `persistence: 'memory'` and `disable_cookie: true`, so no cookies are set. User identification uses PostHog's in-memory distinct_id linked to the authenticated user ID -- fully GDPR-compliant without a consent banner.

