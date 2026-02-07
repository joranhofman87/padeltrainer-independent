

# Remove Percentage-Based Platform Fee References

## Summary

The platform has moved to a flat per-booking fee model (e.g., €1.00, €0.75, €0.50 per booking) plus subscription fees. However, the old percentage-based fee model (10%, 5%, 2.5%) is still referenced in multiple places across the admin dashboard, subscription pages, backend stats calculation, email templates, and terms of service copy. This plan removes all of those remnants.

## Places Where % Fees Are Still Referenced

| Location | What it shows | Action |
|----------|--------------|--------|
| **Admin Dashboard** (`src/pages/AdminDashboard.tsx`) | Hardcoded "Fee Structure" card showing 10%, 5%, 2.5% | Replace with flat fee structure (€1.00, €0.75, €0.50) |
| **Admin Stats Cards** (`src/components/admin/AdminStatsCards.tsx`) | "Avg X% fee" description on Platform Fees card | Change to show flat fee info instead |
| **Admin Stats Edge Function** (`supabase/functions/get-admin-stats/index.ts`) | `TIER_FEES` map with 10/5/2.5, calculates `avgFeePercent`, estimates fees as GMV * percent | Replace with flat fee calculation: count paid bookings per tier, multiply by flat fee per tier |
| **Admin Pricing Table** (`src/pages/admin/AdminPricing.tsx`) | Column showing `platform_fee_percent%` | Remove % column, keep flat fee column |
| **Plan Edit Dialog** (`src/components/admin/PlanEditDialog.tsx`) | Still includes `platform_fee_percent` in form data (submitted on save) | Remove from form state (field is already hidden from UI but still saved) |
| **Trainer Subscription Page** (`src/pages/TrainerSubscription.tsx`) | Shows `{plan.platform_fee_percent}% platform fee` in feature list | Change to show `€{plan.platform_fee_flat} per booking` |
| **Email Template** (`supabase/functions/send-email/index.ts`) | Hardcoded "Platform Fee (10%)" with fallback `price * 0.1` | Use actual flat fee from data, remove % fallback |
| **Terms of Service** (EN: `src/i18n/locales/en/marketing.json`, NL: `src/i18n/locales/nl/marketing.json`) | "percentage varies by subscription plan" | Update to "flat fee per booking" |
| **Subscription lib** (`src/lib/subscription.ts`) | `TRIAL_PLATFORM_FEE_PERCENT`, `platformFeePercent` on each tier, `getPlatformFeePercent()` function | Remove all percentage constants and the function |
| **Admin types** (`src/lib/admin.ts`) | `avgFeePercent` in AdminStats type | Replace with `avgFeeFlat` or remove |

## What Stays

- `platform_fee_percent` column in the database `subscription_plans` table -- we won't drop it now (it can be zeroed out), to avoid a schema migration
- `platform_fee_override` on trainer/academy profiles -- these are already flat fee overrides used in `create-mollie-payment`, they stay as-is
- The actual payment logic in `create-mollie-payment` -- this already uses `platform_fee_flat` correctly

## Technical Details

### 1. `src/pages/AdminDashboard.tsx`
Replace the "Fee Structure" card contents from percentage values (10%, 5%, 2.5%) to flat values (€1.00, €0.75, €0.50) with labels like "per booking".

### 2. `src/components/admin/AdminStatsCards.tsx`
Change the Platform Fees card description from `Avg ${stats.overview.avgFeePercent.toFixed(1)}% fee` to something like `€${stats.overview.avgFeeFlat?.toFixed(2) || '1.00'} avg per booking` or simply show total count of paid bookings.

### 3. `supabase/functions/get-admin-stats/index.ts`
Replace the `TIER_FEES` percentage map with flat fees:
```text
const TIER_FLAT_FEES: Record<string, number> = {
  starter: 1.00,
  professional: 0.75,
  academy: 0.50,
};
```
Calculate estimated platform fees as: sum of (bookings per tier * flat fee) instead of GMV * percentage. Return `avgFeeFlat` instead of `avgFeePercent`.

### 4. `src/pages/admin/AdminPricing.tsx`
Remove the `platform_fee_percent%` column from both trainer and club plan tables.

### 5. `src/components/admin/PlanEditDialog.tsx`
Remove `platform_fee_percent` from the form state so it's no longer submitted on save.

### 6. `src/pages/TrainerSubscription.tsx`
Change line 330 from `{plan.platform_fee_percent}% platform fee` to `€{plan.platform_fee_flat?.toFixed(2)} per booking`.

### 7. `supabase/functions/send-email/index.ts`
Update the booking confirmation email to show "Platform Fee: -€X.XX" using the actual `platformFee` data value, removing the hardcoded "(10%)" label and the `price * 0.1` fallback.

### 8. i18n files (EN + NL)
Update the Terms of Service payment section to reference a flat fee per booking instead of a percentage.

### 9. `src/lib/subscription.ts`
Remove `TRIAL_PLATFORM_FEE_PERCENT`, `platformFeePercent` from tier configs, and the `getPlatformFeePercent()` function entirely. Keep the rest of the file (trial days, tier types, etc.).

### 10. `src/lib/admin.ts`
Update the `AdminStats` type to replace `avgFeePercent` with `avgFeeFlat` (or remove it).

