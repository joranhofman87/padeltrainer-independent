

# Make Academy & Club Subscription Pricing Dynamic

## Problem
Academy and Club subscription pages use hardcoded constants (`ACADEMY_SUBSCRIPTION`, `CLUB_SUBSCRIPTION`) for pricing display. If prices change in the `subscription_plans` table, the UI shows stale values.

## Fix

### 1. Add `useAcademyPlan` hook to `usePricingPlans.ts`
- Update the `plan_type` type from `"trainer" | "club"` to `"trainer" | "club" | "academy"`
- Add `useAcademyPlan()` that filters for `plan_type === "academy"`

### 2. Update `AcademySubscription.tsx`
- Replace `ACADEMY_SUBSCRIPTION` imports with `useAcademyPlan()` hook
- Read `name`, `monthly_price`, `yearly_price` from the DB plan
- Show skeleton while plan is loading

### 3. Update `ClubSubscription.tsx`
- Replace `CLUB_SUBSCRIPTION` imports with `useClubPlan()` hook
- Same pattern as academy

### 4. Update `AcademyLayout.tsx` and `ClubLayout.tsx`
- Remove `ACADEMY_SUBSCRIPTION` / `CLUB_SUBSCRIPTION` imports if only used for pricing display (check if trial days are referenced)
- If trial days are used, keep the constant for that or read from the plan's data

### 5. Keep the constants in `academySubscription.ts` and `clubSubscription.ts` as fallbacks
- Remove the pricing fields, keep only `trialDays` if still needed elsewhere

## File summary

| File | Change |
|------|--------|
| `src/hooks/usePricingPlans.ts` | Add `"academy"` to plan_type, add `useAcademyPlan()` |
| `src/pages/academy/AcademySubscription.tsx` | Use `useAcademyPlan()` instead of hardcoded constant |
| `src/pages/club/ClubSubscription.tsx` | Use `useClubPlan()` instead of hardcoded constant |
| `src/components/academy/AcademyLayout.tsx` | Remove unused `ACADEMY_SUBSCRIPTION` import if applicable |
| `src/components/club/ClubLayout.tsx` | Remove unused `CLUB_SUBSCRIPTION` import if applicable |

