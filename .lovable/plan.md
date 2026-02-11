

## Fix Upgrade Banner Showing for Academy Trainers

### Root Cause

There are two bugs causing the upgrade banner to show incorrectly:

1. **Wrong ID passed to academy check** in `TrainerLayout.tsx` (line 23): `getTrainerAcademy(user.id)` passes the **auth user ID** but the function expects a **trainer profile ID**. This means `hasAcademy` is always `false`, so the academy guard on the subscription overlay never works.

2. **Dashboard banner missing academy check** in `TrainerDashboard.tsx` (line 281): The trial/upgrade banner only checks `!subscription.isSubscribed` but doesn't check whether the trainer belongs to an academy. Academy trainers should never see this banner since their billing is managed at the academy level.

3. **Wrong subscription paths** in `TrainerLayout.tsx` (lines 79, 109): The subscription page detection uses `/trainer/subscription` instead of `/app/trainer/subscription`, so the overlay can't be dismissed even when navigating to the subscription page.

### Changes

**File: `src/components/trainer/TrainerLayout.tsx`**

- Fix the academy check to first look up the trainer profile ID from `trainer_profiles` using `user.id`, then pass that to `getTrainerAcademy()`
- Fix `isOnSubscriptionPage` to check `location.pathname.endsWith('/subscription')`
- Fix `subscriptionPath` from `/trainer/subscription` to `/app/trainer/subscription`

**File: `src/pages/TrainerDashboard.tsx`**

- Add a `hasAcademy` state check (same pattern as TrainerLayout) so the trial banner is hidden for academy trainers
- The banner condition changes from `subscription && !subscription.isSubscribed` to also include `&& !hasAcademy`

**File: `src/pages/TrainerSettings.tsx`**

- Same fix: `getTrainerAcademy(user.id)` should first resolve the trainer profile ID (this file has the same bug)
