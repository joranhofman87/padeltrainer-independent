
# Gate marketplace visibility behind paid subscription

## Problem
Trainers on a free trial can currently toggle their profile to "public" and appear in the marketplace. The business requirement is that only trainers with a **paid subscription** (either their own or via an academy with an active subscription) should be visible.

## Changes

### 1. Update `canBeVisible()` logic
**File: `src/lib/subscription.ts`**

Change `canBeVisible` to only return `true` when the trainer has an active **paid** subscription (`isSubscribed`), removing the trial allowance (`isInTrial`).

```
// Before
return subscription.isSubscribed || subscription.isInTrial;

// After
return subscription.isSubscribed;
```

### 2. Fix TrainerSettings.tsx visibility check
**File: `src/pages/TrainerSettings.tsx`**

The settings page has a second visibility toggle that currently does NOT check whether the trainer belongs to a paid academy. Add the same `isTrainerInPaidAcademy` check that `EditProfile.tsx` already uses:
- Import `isTrainerInPaidAcademy` from `@/lib/academy`
- Make `handleVisibilityToggle` async
- When toggling on and `canBeVisible` is false, also check `isTrainerInPaidAcademy` before blocking
- Update `canToggleVisibility` to account for academy membership (fetch once on mount or use a state variable)

### 3. Update TrainerProfile.tsx public page guard
**File: `src/pages/TrainerProfile.tsx`**

The public profile page already checks `hasSubscriptionAccess` which includes `hasActiveTrial`. Update this to exclude trial-only trainers from being publicly accessible:

```
// Before
const hasSubscriptionAccess = hasActiveSubscription || hasActiveTrial || inPaidAcademy;

// After  
const hasSubscriptionAccess = hasActiveSubscription || inPaidAcademy;
```

This ensures that even if a trial trainer somehow sets `is_public = true`, their profile page won't be accessible to anonymous visitors.

### 4. No database changes needed
The `is_public` column and existing RLS policies remain unchanged. The gating is enforced at the application level in all three locations where visibility is controlled or checked.

## Summary of files modified
- `src/lib/subscription.ts` -- remove trial from `canBeVisible`
- `src/pages/TrainerSettings.tsx` -- add academy membership check to visibility toggle
- `src/pages/TrainerProfile.tsx` -- remove trial from public profile access guard
