

# Fix: Mollie Pay Button Not Showing on Public Invoice Page

## Problem
Two issues are preventing the Mollie payment button from appearing:

1. **Data not fixed**: The previous migration updated the trigger function but the one-time data correction for RL Performance Academy (`org_19475084`) was not included. The flags `charges_enabled`, `payouts_enabled`, and `onboarding_complete` are still `false` in the database despite the academy being fully verified in Mollie.

2. **Missing `trainer_id` in query**: The `get-public-invoice` edge function selects invoice fields on line 29 but does NOT include `trainer_id`, so the fallback trainer Mollie check on line 72 never works.

## Changes

### 1. Database migration — Fix RL Performance Academy data
Run a data update to set the correct flags:
```sql
UPDATE academy_mollie_accounts
SET charges_enabled = true, payouts_enabled = true, onboarding_complete = true
WHERE mollie_organization_id = 'org_19475084';
```

### 2. Fix `get-public-invoice` edge function
**File: `supabase/functions/get-public-invoice/index.ts`**

Add `trainer_id` to the SELECT on line 29 so the trainer Mollie fallback actually works:
```
.select("id, invoice_number, ..., academy_profile_id, trainer_id, public_token")
```

### Files
- Database migration (data fix)
- `supabase/functions/get-public-invoice/index.ts` — add `trainer_id` to select

