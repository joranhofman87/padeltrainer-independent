

# Replace Mollie with Stripe in Admin Pricing Dialog

## Problem
The admin `PlanEditDialog` still shows a "Mollie" tab with Mollie plan/product ID fields. The database already has `stripe_price_id_monthly` and `stripe_price_id_yearly` columns, and the `create-stripe-checkout` edge function uses them. The UI just needs to be updated.

## Changes

### 1. `src/components/admin/PlanEditDialog.tsx`
- Rename the "Mollie" tab to "Stripe"
- Replace the 4 Mollie fields with 2 Stripe fields: `stripe_price_id_monthly` and `stripe_price_id_yearly`
- Update the note text to: "Stripe price IDs are used for subscription billing."
- Update placeholders to `price_xxx`
- Update formData init, state keys, and submit mapping accordingly

### 2. `src/hooks/usePricingPlans.ts`
- Replace the 4 `mollie_*` fields in the `SubscriptionPlan` interface with `stripe_price_id_monthly` and `stripe_price_id_yearly`

No database migration needed — the `stripe_price_id_*` columns already exist in the `subscription_plans` table. The old `mollie_*` columns remain in the DB but are simply no longer surfaced in the admin UI.

