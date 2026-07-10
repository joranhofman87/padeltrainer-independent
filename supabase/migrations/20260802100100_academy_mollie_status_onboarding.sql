-- ============================================================================
-- REBOOK · align the wizard's Mollie-readiness gate with the server's
-- ============================================================================
-- WHY: the rebook wizard enables the STRICT ("only hold the spot after online
-- payment") checkbox as soon as academy_mollie_status.charges_enabled is true.
-- But the SERVER (getAcademyMolliePaymentReadiness / create-invoice-payment) needs
-- MORE to actually open a checkout: onboarding_complete + a valid access token +
-- a live Mollie profile. So an academy could enable strict while the server can't
-- take payment — players then hit "can't start payment" after confirming.
--
-- This re-adds onboarding_complete to the view (the 20260308191403 rewrite dropped
-- it) so the client can gate on charges_enabled AND onboarding_complete — catching
-- the common not-fully-onboarded case with no live API call. (The rarer deleted-
-- profile case still fails server-side with a clear message; guarding it client-side
-- would need a persisted profile id across ~5 payment fns, deferred as heavier than
-- the payoff.) View recreated in place; no data migration. security_invoker = off +
-- GRANT SELECT TO authenticated preserved from the prior definition.
-- ============================================================================

DROP VIEW IF EXISTS public.academy_mollie_status;

CREATE VIEW public.academy_mollie_status
  WITH (security_invoker = off)
AS
  SELECT
    academy_profile_id,
    mollie_organization_id IS NOT NULL AS is_connected,
    charges_enabled,
    onboarding_complete
  FROM public.academy_mollie_accounts;

GRANT SELECT ON public.academy_mollie_status TO authenticated;
