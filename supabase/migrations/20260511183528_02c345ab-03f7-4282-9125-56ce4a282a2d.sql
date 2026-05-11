-- 1. REVOKE SELECT on sensitive columns from authenticated + anon
REVOKE SELECT (iban, bic, btw_number, kvk_number, mollie_customer_id, stripe_customer_id, platform_fee_override)
  ON public.trainer_profiles FROM authenticated, anon;

REVOKE SELECT (iban, bic, btw_number, kvk_number, mollie_customer_id, stripe_customer_id, platform_fee_override)
  ON public.academy_profiles FROM authenticated, anon;

REVOKE SELECT (mollie_customer_id, stripe_customer_id)
  ON public.club_profiles FROM authenticated, anon;

REVOKE SELECT (billing_address, billing_btw_number, billing_business_name, stripe_customer_id)
  ON public.profiles FROM authenticated, anon;

-- 2. SECURITY DEFINER owner views (owned by postgres bypasses column REVOKE; WHERE clause enforces row-level access)
CREATE OR REPLACE VIEW public.trainer_profiles_owner AS
  SELECT * FROM public.trainer_profiles
  WHERE auth.uid() = user_id OR public.is_admin(auth.uid());

CREATE OR REPLACE VIEW public.academy_profiles_owner AS
  SELECT * FROM public.academy_profiles
  WHERE public.is_academy_owner(auth.uid(), id) OR public.is_admin(auth.uid());

CREATE OR REPLACE VIEW public.club_profiles_owner AS
  SELECT * FROM public.club_profiles
  WHERE public.is_club_owner(auth.uid(), id) OR public.is_admin(auth.uid());

CREATE OR REPLACE VIEW public.profiles_owner AS
  SELECT * FROM public.profiles
  WHERE auth.uid() = user_id OR public.is_admin(auth.uid());

ALTER VIEW public.trainer_profiles_owner OWNER TO postgres;
ALTER VIEW public.academy_profiles_owner OWNER TO postgres;
ALTER VIEW public.club_profiles_owner OWNER TO postgres;
ALTER VIEW public.profiles_owner OWNER TO postgres;

GRANT SELECT, UPDATE ON public.trainer_profiles_owner TO authenticated;
GRANT SELECT, UPDATE ON public.academy_profiles_owner TO authenticated;
GRANT SELECT, UPDATE ON public.club_profiles_owner TO authenticated;
GRANT SELECT, UPDATE ON public.profiles_owner TO authenticated;