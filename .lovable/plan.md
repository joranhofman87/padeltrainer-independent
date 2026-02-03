

# Stripe Cleanup Plan: Complete Removal

## Overview

This plan removes all Stripe references from the codebase now that you've fully migrated to Mollie. This includes deleting deprecated edge functions, renaming database columns, cleaning up frontend code, and updating marketing content.

---

## Current Stripe Footprint

After exploring the codebase, I found Stripe references in:

**Edge Functions to DELETE (12 functions):**
- `customer-portal/` - Stripe billing portal
- `create-trainer-checkout/` - Stripe checkout for trainers  
- `create-checkout-session/` - Stripe checkout for bookings
- `create-club-checkout/` - Stripe club checkout
- `club-customer-portal/` - Stripe club billing portal
- `check-trainer-subscription/` - Stripe subscription check
- `check-club-subscription/` - Stripe subscription check
- `verify-payment/` - Stripe payment verification
- `connect-trainer/` - Stripe Connect onboarding
- `connect-club/` - Stripe Connect onboarding
- `check-connect-status/` - Stripe Connect status
- `check-club-connect-status/` - Stripe Connect status

**Database Cleanup:**
- `academy_stripe_accounts` table → rename to `academy_mollie_accounts`
- `subscription_plans` columns: `stripe_price_id_monthly/yearly`, `stripe_product_id_monthly/yearly` → rename to `mollie_*`
- `academy_profiles.stripe_customer_id` → rename to `mollie_customer_id`
- `trainer_profiles.stripe_account_id` → remove (deprecated)

**Frontend/Backend Files to Update:**
- `src/lib/subscription.ts` - Remove Stripe price/product IDs
- `src/pages/TrainerEarnings.tsx` - Remove "Stripe" text references
- `src/pages/TrainerSubscription.tsx` - Remove Stripe checkout flow
- `src/components/admin/AdminStatsCards.tsx` - Update "Stripe Connect" labels
- `supabase/functions/get-admin-stats/index.ts` - Remove Stripe balance API
- `src/hooks/usePricingPlans.ts` - Update column references
- Marketing translations (en/nl) - Change "Stripe" to "Mollie"

---

## Implementation Phases

### Phase 1: Delete Deprecated Edge Functions

Delete the following 12 Stripe-based edge function directories:

```text
supabase/functions/customer-portal/
supabase/functions/create-trainer-checkout/
supabase/functions/create-checkout-session/
supabase/functions/create-club-checkout/
supabase/functions/club-customer-portal/
supabase/functions/check-trainer-subscription/
supabase/functions/check-club-subscription/
supabase/functions/verify-payment/
supabase/functions/connect-trainer/
supabase/functions/connect-club/
supabase/functions/check-connect-status/
supabase/functions/check-club-connect-status/
```

Also update cleanup functions to use Mollie table names:
- `supabase/functions/bulk-cleanup-users/index.ts`
- `supabase/functions/request-account-deletion/index.ts`

### Phase 2: Database Schema Migration

```sql
-- 1. Rename academy_stripe_accounts to academy_mollie_accounts
ALTER TABLE academy_stripe_accounts RENAME TO academy_mollie_accounts;
ALTER TABLE academy_mollie_accounts 
  RENAME COLUMN stripe_account_id TO mollie_organization_id;

-- Add OAuth columns for academies (matching trainer/club tables)
ALTER TABLE academy_mollie_accounts
  ADD COLUMN access_token TEXT,
  ADD COLUMN refresh_token TEXT,
  ADD COLUMN token_expires_at TIMESTAMPTZ;

-- 2. Rename stripe columns in subscription_plans
ALTER TABLE subscription_plans
  RENAME COLUMN stripe_price_id_monthly TO mollie_plan_id_monthly;
ALTER TABLE subscription_plans
  RENAME COLUMN stripe_price_id_yearly TO mollie_plan_id_yearly;
ALTER TABLE subscription_plans
  RENAME COLUMN stripe_product_id_monthly TO mollie_product_id_monthly;
ALTER TABLE subscription_plans
  RENAME COLUMN stripe_product_id_yearly TO mollie_product_id_yearly;

-- 3. Rename academy_profiles.stripe_customer_id
ALTER TABLE academy_profiles
  RENAME COLUMN stripe_customer_id TO mollie_customer_id;

-- 4. Remove deprecated trainer_profiles.stripe_account_id
ALTER TABLE trainer_profiles
  DROP COLUMN IF EXISTS stripe_account_id;
```

### Phase 3: Frontend Code Cleanup

**`src/lib/subscription.ts`:**
- Remove Stripe price IDs (`price_1Spz9V...`)
- Remove Stripe product IDs (`prod_TnaK...`)
- Update comments to reference Mollie

**`src/pages/TrainerEarnings.tsx`:**
- Change "Stripe" text to "payment account" or "Mollie"

**`src/components/admin/AdminStatsCards.tsx`:**
- Change "Stripe Connect" label to "Mollie Connect"
- Change "Stripe Balance" to "Mollie Balance"

**`src/pages/admin/AdminAcademies.tsx`:**
- Update table reference from `academy_stripe_accounts` to `academy_mollie_accounts`

**`src/hooks/usePricingPlans.ts`:**
- Update TypeScript interface to use `mollie_*` column names

### Phase 4: Edge Function Updates

**`supabase/functions/get-admin-stats/index.ts`:**
- Replace Stripe import with Mollie API call
- Rename `trainer_stripe_accounts` → `trainer_mollie_accounts`
- Remove `stripeSecretKey` usage
- Fetch balance from Mollie instead

### Phase 5: Translation File Updates

Update marketing content in:
- `src/i18n/locales/en/marketing.json`
- `src/i18n/locales/nl/marketing.json`

Changes:
- FAQ "How do payouts work?" - Change "Stripe Connect" to "our payment partner"
- Privacy "Payment Information" - Change "Stripe" to "Mollie"
- Privacy "Service Providers" - Change "Stripe" to "Mollie"
- Terms "For Players" - Change "Stripe" to "Mollie"
- Terms "For Trainers" - Change "Stripe-account" to "payment account"

---

## Technical Notes

### Functions Already Created (Mollie)
These already exist and will be the primary payment functions:
- `mollie-connect-trainer` / `mollie-connect-club`
- `mollie-callback`
- `check-mollie-connect-status`
- `create-mollie-payment`
- `mollie-webhook`
- `verify-mollie-payment`
- `create-mollie-subscription` / `create-club-mollie-subscription`
- `check-mollie-subscription`
- `cancel-mollie-subscription`

### Types File
The `src/integrations/supabase/types.ts` file will auto-regenerate after database migrations run, updating the TypeScript types automatically.

---

## Summary

| Phase | Scope | Changes |
|-------|-------|---------|
| 1 | Edge Functions | Delete 12 Stripe functions |
| 2 | Database | 1 table rename, 6 column renames |
| 3 | Frontend | Update 5 files |
| 4 | Admin Function | Update get-admin-stats |
| 5 | Translations | Update 2 JSON files |

