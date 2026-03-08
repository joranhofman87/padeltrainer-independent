

# PostHog Tracking Gaps and Fix Plan

## Current State

**What's tracked (10 pages):**
- Signup: `signup_started`, `signup_completed` (Player, Trainer)
- Login: `login` with method
- Onboarding: 6 step events (trainer flow)
- Player onboarding: `player_onboarding_completed`
- Subscription: `subscription_page_viewed`, `checkout_started`, `activated`, `canceled`
- Profile views: `trainer_profile_viewed`, `academy_profile_viewed`
- Pricing: `pricing_page_viewed`
- Booking: `booking_paid` (success page only)
- Payment: `payment_connected` (Mollie callback)

**What's NOT tracked (critical gaps):**

| Gap | Impact |
|-----|--------|
| Homepage — no page view or CTA click events | Can't measure top-of-funnel |
| BookLesson.tsx — zero tracking | Can't see booking funnel drop-off |
| CycleRegistration.tsx — zero tracking | Can't see registration conversion |
| No UTM parameter capture anywhere | Can't attribute signups to campaigns |
| Academy/Club signup pages — no tracking | Missing half your signup funnel |
| Pricing CTA clicks — no plan preference data | Don't know which tier attracts clicks |
| robots.txt — exposes raw backend URL | Minor SEO/security hygiene |

---

## Implementation Plan

### 1. UTM Capture Utility (new file)
Create `src/lib/utm.ts`:
- On load, parse `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term` from URL
- Store in `sessionStorage` so they survive the signup redirect chain
- Export `getUtmParams()` for use in tracking calls
- Register as PostHog super properties so they auto-attach to all events

### 2. Homepage Tracking (2 files)
- **Home.tsx**: Add `trackEvent('home_page_viewed')` on mount
- **HeroSection.tsx**: Add `trackEvent('cta_clicked', { location: 'hero' })` on primary CTA

### 3. Booking Funnel Tracking (1 file)
- **BookLesson.tsx**: Add events at key steps:
  - `booking_page_viewed` on mount (with trainer_id, slot_id)
  - `booking_payment_initiated` when user clicks pay
  - Links to existing `booking_paid` on BookingSuccess

### 4. Cycle Registration Tracking (1 file)
- **CycleRegistration.tsx**: Add:
  - `cycle_registration_viewed` on mount (with cycle_id, owner_type)
  - `cycle_registration_completed` on success callback

### 5. Missing Signup Page Tracking (2 files)
- **AcademySignup.tsx** and **ClubSignup.tsx**: Add `signup_started`/`signup_completed` events matching the Player/Trainer pattern

### 6. Pricing Plan Click Tracking (1 file)
- **Pricing.tsx**: Add `trackEvent('pricing_plan_selected', { plan, billing_cycle })` on each plan's CTA click

### 7. UTM Integration (2 files)
- **MarketingLayout.tsx**: Call UTM capture on mount
- **All signup pages**: Include `...getUtmParams()` in `signup_started` event properties

### 8. robots.txt Cleanup (1 file)
- Replace raw backend URL with `https://padeltrainer.ai/llms-full.txt`

---

## Summary

| Phase | Files | Events Added |
|-------|-------|-------------|
| UTM utility | 1 new | Super properties |
| Homepage | 2 | 2 events |
| Booking funnel | 1 | 2 events |
| Cycle registration | 1 | 2 events |
| Academy/Club signup | 2 | 4 events |
| Pricing clicks | 1 | 1 event |
| UTM wiring | 2 | Properties on all signup events |
| robots.txt | 1 | — |

**Total: ~11 files, 1 new utility. Gives you a complete measurable funnel from ad click to paid subscription.**

