-- 1. Fix admin_impersonation_logs INSERT policy
DROP POLICY IF EXISTS "Service role can insert impersonation logs" ON admin_impersonation_logs;
CREATE POLICY "Admins can insert impersonation logs"
  ON admin_impersonation_logs FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin(auth.uid()));

-- 2. Add trigger to protect Mollie verification fields on all three tables
CREATE OR REPLACE FUNCTION public.protect_mollie_verification_fields()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path TO 'public'
AS $$
BEGIN
  -- If verification fields are being changed, block non-service-role callers
  IF (OLD.charges_enabled IS DISTINCT FROM NEW.charges_enabled)
     OR (OLD.payouts_enabled IS DISTINCT FROM NEW.payouts_enabled)
     OR (OLD.onboarding_complete IS DISTINCT FROM NEW.onboarding_complete)
  THEN
    -- Service role bypasses RLS entirely, so this trigger only fires for
    -- regular authenticated users. Block them from changing these fields.
    NEW.charges_enabled := OLD.charges_enabled;
    NEW.payouts_enabled := OLD.payouts_enabled;
    NEW.onboarding_complete := OLD.onboarding_complete;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER protect_club_mollie_verification
  BEFORE UPDATE ON club_mollie_accounts
  FOR EACH ROW
  EXECUTE FUNCTION protect_mollie_verification_fields();

CREATE TRIGGER protect_trainer_mollie_verification
  BEFORE UPDATE ON trainer_mollie_accounts
  FOR EACH ROW
  EXECUTE FUNCTION protect_mollie_verification_fields();

CREATE TRIGGER protect_academy_mollie_verification
  BEFORE UPDATE ON academy_mollie_accounts
  FOR EACH ROW
  EXECUTE FUNCTION protect_mollie_verification_fields();