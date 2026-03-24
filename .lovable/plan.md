

# Fix: Force Data Update for RL Performance Academy Mollie Flags

## Problem
Two previous migrations attempted to set `charges_enabled`, `payouts_enabled`, and `onboarding_complete` to `true` for `org_19475084`, but the database still shows all three as `false`. The migrations were created as files but never successfully applied.

The `get-public-invoice` edge function checks these flags (line 68) and returns `hasMollieAccount: false`, so the Pay button never appears.

## Solution
Create a new migration to update the flags. This is the same SQL — we just need it to actually execute this time:

```sql
UPDATE academy_mollie_accounts
SET charges_enabled = true,
    payouts_enabled = true,
    onboarding_complete = true
WHERE mollie_organization_id = 'org_19475084';
```

No code changes needed — the edge function and frontend logic are already correct. Once the data is fixed, `hasMollieAccount` will return `true` and the Mollie Pay button will appear.

## Files
- Database migration only (data fix)

