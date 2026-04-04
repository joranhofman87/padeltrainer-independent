

# Propagate Pricing from Registration to Generated Slots

## Problem
When `generate-proposals` creates `availability_slots` from a registration, it doesn't carry over pricing fields (`price_per_session`, `extra_costs`, `split_payment`, `prices_include_vat`). These fields exist on the `availability_slots` table but are never populated. The admin should also be able to review and adjust these values before finalizing.

## Changes

### 1. `supabase/functions/generate-proposals/index.ts` — Add pricing fields to slot inserts

Extract pricing from the cycle record and its settings, then include in each slot insert:

```
price_per_session: cycle.price_per_session || null
extra_costs: cycle.settings?.extra_costs || []
split_payment: cycle.settings?.split_payment || false
prices_include_vat: cycle.settings?.prices_include_vat ?? true
```

Also compute `total_price` per slot as `price_per_session × total_weeks_for_this_slot_group` (number of weeks the cycle spans).

This ensures newly generated slots inherit the registration's pricing configuration.

### 2. `src/pages/academy/AcademyCycleDetail.tsx` — Add pricing summary card at Step 4 (Review & Edit)

Above the `ProposalScheduleGrid` in the review-edit step, add an editable "Pricing" card showing:
- **Price per session** (number input, pre-filled from cycle)
- **Extra costs** (list with add/remove, using `ExtraCostPresetPicker`)
- **VAT inclusive/exclusive** (toggle switch)
- **Split payment** (toggle switch)

State is initialized from `cycle.settings` / `cycle.price_per_session`. When the admin clicks "Continue to Approve", save any changes back to the cycle record AND bulk-update all generated slots with the (potentially modified) pricing values.

### 3. `src/lib/cycles.ts` — Add `updateCyclePricing` helper

A function that:
1. Updates the cycle's `price_per_session` and `settings` (extra_costs, split_payment, prices_include_vat)
2. Bulk-updates all `availability_slots` with `cyclus_id = cycleId` to apply the new pricing fields

## File summary

| File | Change |
|------|--------|
| `supabase/functions/generate-proposals/index.ts` | Add pricing fields to slot insert objects (~5 lines added around line 618) |
| `src/pages/academy/AcademyCycleDetail.tsx` | Add editable pricing card in Step 4, save pricing on "Continue to Approve" |
| `src/lib/cycles.ts` | Add `updateCyclePricing()` helper to sync pricing to cycle + slots |

