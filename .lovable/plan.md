

# Fix Payment Availability Check Using Secure Database Views

## Problem
Players cannot book sessions with Mollie-connected trainers because RLS policies on `trainer_mollie_accounts` and `academy_mollie_accounts` block players from reading the trainer's payment status. The `hasValidPaymentSetup()` function returns `valid: false`, showing "Payment Not Available."

## Solution

### 1. Database Migration -- Create two secure views

Create `trainer_mollie_status` and `academy_mollie_status` views that expose only non-sensitive fields (no tokens, no secrets) to any authenticated user.

```sql
-- Trainer view
CREATE VIEW public.trainer_mollie_status AS
SELECT 
  trainer_id,
  charges_enabled,
  onboarding_complete,
  (mollie_organization_id IS NOT NULL 
   AND NOT mollie_organization_id LIKE 'pending_%') AS is_connected
FROM public.trainer_mollie_accounts;

-- Academy view
CREATE VIEW public.academy_mollie_status AS
SELECT 
  academy_profile_id,
  charges_enabled,
  onboarding_complete,
  (mollie_organization_id IS NOT NULL 
   AND NOT mollie_organization_id LIKE 'pending_%') AS is_connected
FROM public.academy_mollie_accounts;
```

### 2. `src/lib/academyTrainerPayments.ts` -- Query views instead of raw tables

Update `getAcademyPaymentInfo` (line ~39) and `hasValidPaymentSetup` (line ~105) to use the new views:

- `academy_mollie_accounts` becomes `academy_mollie_status`
- `trainer_mollie_accounts` becomes `trainer_mollie_status`
- Check `charges_enabled` directly instead of casting through `mollie_organization_id`

### 3. Security

- Views exclude `access_token`, `refresh_token`, `token_expires_at`, and raw `mollie_organization_id`
- RLS on the underlying tables remains unchanged (trainers/academies still own their full records)
- Any authenticated user can read the view to check if payment is available -- which is required for the booking flow

