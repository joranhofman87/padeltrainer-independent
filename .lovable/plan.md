

# Fix: Academy Cyclus Creation RLS Error

## Problem
When creating a cyclus from the Academy Calendar, the `academy_profile_id` on the inserted slots is `null`. The RLS INSERT policy requires either:
1. `trainer_id` matches the current user's trainer profile, OR
2. `academy_profile_id` matches one of the user's academies

Since the academy manager may not own the trainer profile, policy 1 fails. And since `academy_profile_id` is null, policy 2 also fails → 403 error.

## Root Cause
In `AddSlotDialog.tsx`, `createDefaultSlotConfig()` (line 508) hardcodes `academyProfileId: null`. The `academyId` prop passed from `AcademyCalendar.tsx` is never used to set this value on new slot configs.

## Fix

**File**: `src/components/trainer/AddSlotDialog.tsx`

1. **Pass `academyId` into `createDefaultSlotConfig`**: Add an `academyId` parameter and use it to set `academyProfileId` instead of `null`
2. **Update all call sites** of `createDefaultSlotConfig` within the component (lines 535, 563) to pass `academyId`
3. The "add recurring slot" button (line 661) already copies from `lastSlot.academyProfileId`, so that's fine

This ensures that when creating slots from the academy context, every slot has the correct `academy_profile_id` set, satisfying the RLS policy.

## Changes

| File | Change |
|------|--------|
| `src/components/trainer/AddSlotDialog.tsx` | Add `academyId` parameter to `createDefaultSlotConfig`; set `academyProfileId: academyId \|\| null`; update all call sites (lines 535, 563) to pass `academyId` prop |

