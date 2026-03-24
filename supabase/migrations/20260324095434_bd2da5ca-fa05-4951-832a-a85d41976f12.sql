
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
