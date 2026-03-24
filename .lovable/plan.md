

# Fix: Mollie Payment Not Working + Remove Manual Payment Link Button

## Problem
1. **Data migration not applied**: The flags `charges_enabled`, `payouts_enabled`, and `onboarding_complete` are still `false` for RL Performance Academy (`org_19475084`). The previous migration file exists but was never executed against the database. This causes both the public invoice page (no Pay button shown) and the `create-invoice-payment` function (returns "No connected Mollie account found") to fail.

2. **Manual "Payment link" button on academy invoices page**: This button calls `create-invoice-payment` from the dashboard, which is redundant — the payment is created automatically when the player clicks "Pay" on the public invoice page. The button causes confusion and errors.

## Changes

### 1. Re-apply data fix via new migration
Run a new database migration to set the correct flags:
```sql
UPDATE academy_mollie_accounts
SET charges_enabled = true, payouts_enabled = true, onboarding_complete = true
WHERE mollie_organization_id = 'org_19475084';
```

### 2. Remove the manual "Payment link" button from AcademyInvoices
**File: `src/pages/academy/AcademyInvoices.tsx`**
- Remove the `generateLinkMutation` and the payment link button (chain icon) from invoice rows
- Keep the "Share" button (which shares the public invoice URL) — that's the correct flow
- The player visits the public URL and clicks Pay there, which triggers `create-invoice-payment` automatically

## Files
- Database migration (data fix)
- `src/pages/academy/AcademyInvoices.tsx` — Remove payment link button and mutation

