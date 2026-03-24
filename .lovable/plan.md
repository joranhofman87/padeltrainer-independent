

# Fix: Mollie Verification Fields Blocked by Database Trigger

## Problem
The `protect_mollie_verification_fields` trigger fires on **all** updates to the Mollie account tables, silently reverting `charges_enabled`, `payouts_enabled`, and `onboarding_complete` back to their old values. This happens even when the `mollie-callback` edge function uses the service role key, because triggers fire regardless of role — only RLS is bypassed by service role.

**Result**: The OAuth callback saves tokens successfully but the verification flags stay `false`, making it look like the account isn't ready for payments — even though Mollie shows it as fully active and verified.

## Solution

### 1. Fix the trigger to allow service-role updates
**Database migration**

Update `protect_mollie_verification_fields()` to check `current_setting('role')`. When the caller is `service_role`, allow the update. Only block changes for `authenticated` or `anon` roles.

```sql
CREATE OR REPLACE FUNCTION public.protect_mollie_verification_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  -- Service role (used by edge functions) is allowed to update these fields
  IF current_setting('request.jwt.claim.role', true) = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Block regular users from changing verification fields
  IF (OLD.charges_enabled IS DISTINCT FROM NEW.charges_enabled)
     OR (OLD.payouts_enabled IS DISTINCT FROM NEW.payouts_enabled)
     OR (OLD.onboarding_complete IS DISTINCT FROM NEW.onboarding_complete)
  THEN
    NEW.charges_enabled := OLD.charges_enabled;
    NEW.payouts_enabled := OLD.payouts_enabled;
    NEW.onboarding_complete := OLD.onboarding_complete;
  END IF;
  RETURN NEW;
END;
$$;
```

### 2. Fix RL Performance Academy's current data
**Database migration** — one-time update to set the correct flags for the already-verified account:

```sql
UPDATE academy_mollie_accounts
SET charges_enabled = true, payouts_enabled = true, onboarding_complete = true
WHERE mollie_organization_id = 'org_19475084';
```

## Files
- Database migration only — no code file changes needed

