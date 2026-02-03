

# Unified Subscription Paywall System for All Roles

## Problem Summary

1. **Academy subscription not being checked**: RL Performance Academy shows an upgrade banner despite having `subscription_status: active` in the database
2. **No paywall exists for any role**: Trainers, Clubs, and Academies can all access features even without an active subscription
3. **Missing AcademySubscription page**: The page file and route don't exist
4. **Inconsistent implementation**: Each role handles subscriptions differently

## Solution: Unified Subscription Pattern

Create a consistent paywall/lock mechanism that works identically across Trainer, Club, and Academy roles.

---

## Implementation Overview

### Phase 1: Create Shared Subscription Overlay Component

**File:** `src/components/shared/SubscriptionOverlay.tsx`

A reusable full-screen overlay component that:
- Blocks all content except navigation to the subscription page
- Accepts role-specific props (pricing, features, route)
- Shows trial countdown if applicable
- Works for trainer, club, and academy

```text
┌────────────────────────────────────────────────────────────┐
│                  SubscriptionOverlay                        │
│                                                              │
│  Props:                                                      │
│  - roleName: "Trainer" | "Club" | "Academy"                 │
│  - subscriptionPath: "/subscription" | "/club/subscription" │
│  - pricing: { monthly, yearly }                              │
│  - features: string[]                                        │
│  - trialDaysRemaining?: number                               │
│  - isTrialExpired: boolean                                   │
│                                                              │
│  Renders:                                                    │
│  - Semi-transparent backdrop covering all content            │
│  - Modal card with upgrade messaging                         │
│  - Feature highlights                                        │
│  - "Upgrade Now" CTA button                                  │
└────────────────────────────────────────────────────────────┘
```

---

### Phase 2: Academy Subscription Infrastructure

**2.1 Create `src/lib/academySubscription.ts`**
- Mirror pattern from `clubSubscription.ts`
- `checkAcademySubscription(academyId)` - Calls `check-mollie-subscription` with `type: "academy"`
- `createAcademyCheckout(academyId)` - Creates Mollie checkout session
- `cancelAcademySubscription(academyId)` - Cancels subscription
- `ACADEMY_SUBSCRIPTION` constant (€199/month, 14-day trial)

**2.2 Update Edge Function `check-mollie-subscription`**
- Add `type: "academy"` case alongside existing trainer and club
- Query `academy_profiles` table with `academy_managers` join for authorization
- Return consistent response shape

**2.3 Create `src/pages/academy/AcademySubscription.tsx`**
- Model after `ClubSubscription.tsx` for consistency
- Uses new academySubscription lib functions

**2.4 Add Route**
- Add `/academy/subscription` route in DomainRouter

---

### Phase 3: Integrate Paywall into Layouts

**3.1 Update `AcademyLayout.tsx`**
- Extend context to include subscription state
- Check subscription when academy loads
- Render `SubscriptionOverlay` when subscription inactive and not on subscription page

**3.2 Update `ClubLayout.tsx`**
- Check club subscription status using existing `checkClubSubscription()`
- Add subscription context fields
- Render `SubscriptionOverlay` when subscription inactive/expired

**3.3 Update `TrainerLayout.tsx`**
- Use existing `useAuth().subscription` data
- Add `SubscriptionOverlay` when subscription inactive and not on subscription page

---

### Phase 4: Update Dashboard Banners

Add consistent subscription alert banners across all dashboards:

**Files:**
- `src/pages/TrainerDashboard.tsx` - Add trial/subscription banners
- `src/pages/club/ClubDashboard.tsx` - Add trial/subscription banners  
- `src/pages/academy/AcademyDashboard.tsx` - Add trial/subscription banners

Banner types:
- Green: Trial active with countdown
- Red: Trial expired / No subscription
- Yellow: Subscription ending soon

---

### Phase 5: i18n Translations

**Files to update:**
- `src/i18n/locales/en/academy.json`
- `src/i18n/locales/nl/academy.json`
- `src/i18n/locales/en/trainer.json` (add missing subscription keys)
- `src/i18n/locales/nl/trainer.json`

Add subscription overlay translations:
```json
"subscriptionOverlay": {
  "title": "Subscription Required",
  "description": "Upgrade to access all features",
  "trialExpired": "Your trial has expired",
  "upgradeNow": "Upgrade Now",
  "features": "What you'll get:",
  "trialDaysRemaining": "{{days}} days left in trial"
}
```

---

## Technical Flow

```text
User loads /trainer, /club, or /academy
            │
            ▼
┌─────────────────────────────────────────┐
│ Layout Component Loads                   │
│ - Fetches subscription status            │
│ - Determines: hasActiveSubscription      │
└───────────────┬─────────────────────────┘
                │
                ▼
        ┌───────────────────┐
        │ Has active         │
        │ subscription?      │
        └─────────┬─────────┘
              │         │
            YES        NO
              │         │
              ▼         ▼
        ┌────────┐  ┌──────────────────────┐
        │ Normal │  │ Is on subscription   │
        │ Access │  │ page?                │
        └────────┘  └─────────┬────────────┘
                          │         │
                        YES        NO
                          │         │
                          ▼         ▼
                    ┌────────┐ ┌─────────────────┐
                    │ Show   │ │ Show Paywall    │
                    │ Page   │ │ Overlay         │
                    └────────┘ └─────────────────┘
```

---

## Files Summary

### New Files to Create
1. `src/components/shared/SubscriptionOverlay.tsx` - Reusable paywall component
2. `src/lib/academySubscription.ts` - Academy subscription utilities
3. `src/pages/academy/AcademySubscription.tsx` - Academy subscription page

### Files to Modify
1. `supabase/functions/check-mollie-subscription/index.ts` - Add academy type
2. `src/components/academy/AcademyLayout.tsx` - Add subscription check + overlay
3. `src/components/club/ClubLayout.tsx` - Add subscription check + overlay
4. `src/components/trainer/TrainerLayout.tsx` - Add subscription check + overlay
5. `src/pages/TrainerDashboard.tsx` - Add subscription banners
6. `src/pages/club/ClubDashboard.tsx` - Add subscription banners
7. `src/pages/academy/AcademyDashboard.tsx` - Add subscription banners
8. `src/components/DomainRouter.tsx` - Add academy subscription route
9. `src/i18n/locales/en/academy.json` - Add translations
10. `src/i18n/locales/nl/academy.json` - Add translations
11. `src/i18n/locales/en/trainer.json` - Add overlay translations
12. `src/i18n/locales/nl/trainer.json` - Add overlay translations
13. `src/i18n/locales/en/club.json` - Add overlay translations (if missing)
14. `src/i18n/locales/nl/club.json` - Add overlay translations (if missing)

---

## Expected Outcome

After implementation:

| Scenario | Before | After |
|----------|--------|-------|
| RL Performance Academy (active) | Shows upgrade banner | Full access, no barriers |
| Trainer with active sub | Full access | Full access (same) |
| Trainer without sub | Full access | Locked with paywall |
| Club in trial | Full access | Full access + trial banner |
| Club trial expired | Full access | Locked with paywall |
| Academy without sub | Full access | Locked with paywall |

The unified `SubscriptionOverlay` component ensures visual and behavioral consistency across all three role types.

