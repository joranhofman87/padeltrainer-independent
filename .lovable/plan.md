
# Obsolete Code and Complexity Analysis

After a thorough analysis of the codebase, I've identified several areas of obsolete code, legacy patterns, and unnecessary complexity that can be cleaned up.

---

## 1. Stripe Remnants (CRITICAL - Legacy Payment System)

**Issue**: The platform migrated from Stripe to Mollie, but database tables and type references still contain Stripe naming.

| Location | Issue |
|----------|-------|
| `src/integrations/supabase/types.ts` | Contains `academy_stripe_accounts`, `club_stripe_accounts`, `trainer_stripe_accounts` table types |
| Database foreign keys | Named `academy_stripe_accounts_academy_profile_id_fkey`, `club_stripe_accounts_club_profile_id_fkey`, etc. |
| `src/lib/subscription.ts` | Contains Stripe `priceId` and `productId` values (e.g., `price_1Spz9VPxAlHS6UZH9wmgdECd`, `prod_TnaKMqklQL0csZ`) |
| `src/lib/clubSubscription.ts` | Contains Stripe `priceId: "price_1SqSZBPxAlHS6UZHJHw1xUFB"`, `productId: "prod_TobiJfC96Jjf3h"` |

**Recommendation**: 
- Rename database tables from `*_stripe_accounts` to `*_mollie_accounts`
- Remove hardcoded Stripe price/product IDs since Mollie doesn't use them
- These IDs are vestiges of the old Stripe integration and serve no purpose with Mollie

---

## 2. Club Mollie/Payment Infrastructure (Obsolete per Recent Decision)

**Issue**: Club payment collection was recently deprecated (clubs don't collect payments - academies do), but code remains.

| File | Status |
|------|--------|
| `supabase/functions/create-club-mollie-subscription/index.ts` | Should be DELETED - calls club Mollie subscription |
| `src/lib/clubTrainerPayments.ts` | References `club_mollie_accounts` - should be REVIEWED/DELETED |
| `supabase/functions/cancel-mollie-subscription/index.ts` | Still handles `type === "club"` case |
| `supabase/functions/check-mollie-subscription/index.ts` | Still handles `type === "club"` case |
| `src/lib/clubSubscription.ts` | References `create-club-mollie-subscription` function |

**Recommendation**:
- Delete `create-club-mollie-subscription` edge function
- Remove club payment collection references from `clubTrainerPayments.ts`
- Update `cancel-mollie-subscription` and `check-mollie-subscription` to remove club payment handling (keep subscription handling)
- Keep club SUBSCRIPTION infrastructure (clubs still pay for platform access)

---

## 3. Legacy Function Aliases and Backward Compatibility Code

**Issue**: Duplicate/aliased functions kept for "backward compatibility" that add confusion.

| Location | Issue |
|----------|-------|
| `src/lib/subscription.ts:50` | `TRIAL_TIER = STARTER_TIER` - unnecessary alias |
| `src/lib/subscription.ts:86-89` | `isTrialExpiredLegacy()` - marked legacy, duplicates `isDateExpired()` from sharedSubscription |
| `src/lib/subscription.ts:83` | Re-exports `isDateExpired as isTrialExpired` - confusing naming |
| Multiple files | `getTrialDaysRemaining` is re-exported in multiple places instead of importing from source |

**Recommendation**:
- Remove `TRIAL_TIER` alias, use `STARTER_TIER` directly
- Delete `isTrialExpiredLegacy()` function
- Standardize on `isDateExpired()` from `sharedSubscription.ts`
- Import `getTrialDaysRemaining` directly from `sharedSubscription.ts` everywhere

---

## 4. Legacy Routes (Duplicate Path Handling)

**Issue**: Multiple routes point to the same components for "backwards compatibility."

| Legacy Route | Redirects To | Component |
|--------------|--------------|-----------|
| `/lessons` | - | `ManageLessons` (same as nowhere else uses it) |
| `/availability` | - | `TrainerCalendar` |
| `/schedule` | - | `TrainerCalendar` |
| `/trainer-bookings` | - | `TrainerBookings` |
| `/earnings` | - | `TrainerEarnings` |
| `/subscription` | - | `TrainerSubscription` |
| `/analytics` | - | `TrainerAnalytics` |
| `/settings/notifications` | - | `NotificationSettings` |
| `/settings/calendar` | - | `CalendarSettings` |

Many of these are also defined inside the `/trainer` route group.

**Recommendation**:
- Consolidate routes under `/trainer/*` namespace
- Add redirect rules for legacy routes instead of duplicating
- Remove standalone legacy route definitions from `DomainRouter.tsx` (lines 205-217, 313-325)

---

## 5. Unused/Redundant Pages

**Issue**: Some pages appear to overlap in functionality or may be unused.

| Page | Issue |
|------|-------|
| `ManageSchedule.tsx` (741 lines) | Complex page for working hours + bulk slots - duplicates TrainerCalendar functionality |
| `ManageAvailability.tsx` (521 lines) | Individual slot management - overlaps with TrainerCalendar |
| `ManageLessons.tsx` | Lesson CRUD - unclear if still primary path |
| `OpenSlots.tsx` | View of open slots - could be tab in TrainerCalendar |

**Recommendation**:
- Audit actual usage of these pages
- Consider consolidating schedule/availability management into `TrainerCalendar`
- The setup checklist in `TrainerDashboard` still references `/lessons` and `/schedule` - needs updating

---

## 6. TrainerDashboard Complexity (1156 lines)

**Issue**: The TrainerDashboard is significantly more complex than other dashboards (Club: ~156 lines, Academy: ~186 lines).

It contains:
- Full calendar grid
- Setup checklist
- Stats cards
- Trial banner
- Multiple dialog components
- Complex state management

**Recommendation**:
- Extract calendar into separate component
- Move setup checklist to its own component file
- Move trial banner to shared component (already exists in other dashboards)
- Target: Reduce to ~400-500 lines by component extraction

---

## 7. Database Tables to Clean Up

Based on the Stripe migration and club payment changes:

| Table | Action |
|-------|--------|
| `academy_stripe_accounts` | RENAME to `academy_mollie_accounts` (if not already exists) or DELETE if duplicate |
| `club_stripe_accounts` | RENAME to `club_mollie_accounts` (if not already exists) or DELETE if duplicate |
| `trainer_stripe_accounts` | RENAME to `trainer_mollie_accounts` (if not already exists) or DELETE if duplicate |
| `club_mollie_accounts` | KEEP - used for club subscriptions (not payments) |

---

## 8. Secrets to Clean Up

| Secret | Status |
|--------|--------|
| `STRIPE_SECRET_KEY` | REMOVE - Stripe is no longer used |

---

## 9. Academy Subscription Placeholder Values

**Issue**: `src/lib/academySubscription.ts` contains placeholder IDs.

```typescript
export const ACADEMY_SUBSCRIPTION = {
  priceId: "price_academy_monthly", // Update with actual Mollie price ID
  productId: "prod_academy", // Update with actual Mollie product ID
  ...
};
```

**Recommendation**: These Stripe-style IDs aren't used by Mollie - remove them or document they're unused.

---

## Summary: Cleanup Priority

### High Priority (Remove immediately)
1. Delete `create-club-mollie-subscription` edge function
2. Remove `STRIPE_SECRET_KEY` secret
3. Remove `isTrialExpiredLegacy()` function
4. Remove `TRIAL_TIER` alias

### Medium Priority (Consolidate)
1. Consolidate legacy routes into redirects
2. Rename database tables from `*_stripe_*` to `*_mollie_*`
3. Remove Stripe priceId/productId values from subscription configs
4. Update `cancel-mollie-subscription` and `check-mollie-subscription` to remove club payment handling

### Lower Priority (Refactor)
1. Extract TrainerDashboard components
2. Consolidate ManageSchedule/ManageAvailability into TrainerCalendar
3. Standardize imports of shared subscription utilities

---

## Files to Delete

| File | Reason |
|------|--------|
| `supabase/functions/create-club-mollie-subscription/index.ts` | Clubs no longer collect payments |

## Files to Modify

| File | Changes |
|------|---------|
| `src/lib/subscription.ts` | Remove `TRIAL_TIER`, `isTrialExpiredLegacy`, Stripe IDs |
| `src/lib/clubSubscription.ts` | Remove Stripe priceId/productId |
| `src/lib/academySubscription.ts` | Remove placeholder priceId/productId |
| `src/lib/clubTrainerPayments.ts` | Remove or update (clubs don't collect payments) |
| `supabase/functions/cancel-mollie-subscription/index.ts` | Remove club payment handling |
| `supabase/functions/check-mollie-subscription/index.ts` | Remove club-specific payment logic |
| `src/components/DomainRouter.tsx` | Consolidate legacy routes |
| `src/pages/TrainerDashboard.tsx` | Extract components to reduce complexity |

