-- Email remediation — hardening from the adversarial security review.
--
-- (1) CRITICAL: the capability gate missed multi-tenancy established purely via
--     BOOKINGS (a slot owned by another academy/trainer, with no metadata/invoice
--     row). A shared player looked single-tenant -> 'direct' -> one academy could
--     overwrite the login email and lock out the other. Now the org check also
--     unions bookings -> availability_slots (academy_profile_id / trainer_id).
-- (2) HIGH: 'never logged in' was last_sign_in_at IS NULL only. A player who
--     CONFIRMED their account (clicked the email link) but never did an interactive
--     login could slip through. Require email_confirmed_at IS NULL too -> only a
--     truly nascent, academy-created, never-activated account is eligible.
-- (3) a format CHECK on the billing-email override.

CREATE OR REPLACE FUNCTION public.get_player_email_edit_capability(
  _profile_id uuid,
  _academy_profile_id uuid
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owned           boolean;
  v_other_orgs      integer;
  v_never_logged_in boolean;
BEGIN
  IF NOT (public.is_academy_manager(auth.uid(), _academy_profile_id) OR public.is_admin(auth.uid())) THEN
    RAISE EXCEPTION 'not authorized for academy %', _academy_profile_id USING ERRCODE = '42501';
  END IF;

  IF _profile_id IS NULL THEN
    RETURN 'override';  -- guests are edited inline, not via this gate
  END IF;

  -- this academy must actively own the player
  SELECT EXISTS (
    SELECT 1 FROM public.academy_player_metadata m
    WHERE m.profile_id = _profile_id AND m.academy_profile_id = _academy_profile_id AND m.removed_at IS NULL
  ) INTO v_owned;
  IF NOT v_owned THEN
    RETURN 'override';
  END IF;

  -- any OTHER academy/trainer linked to this player — roster, invoices, OR bookings.
  SELECT count(*) INTO v_other_orgs FROM (
    SELECT 'a:' || m.academy_profile_id::text AS org FROM public.academy_player_metadata m
      WHERE m.profile_id = _profile_id AND m.removed_at IS NULL AND m.academy_profile_id IS NOT NULL
    UNION
    SELECT 't:' || m.trainer_profile_id::text FROM public.academy_player_metadata m
      WHERE m.profile_id = _profile_id AND m.removed_at IS NULL AND m.trainer_profile_id IS NOT NULL
    UNION
    SELECT 'a:' || i.academy_profile_id::text FROM public.invoices i
      WHERE i.player_id = _profile_id AND i.academy_profile_id IS NOT NULL
    UNION
    SELECT 't:' || i.trainer_id::text FROM public.invoices i
      WHERE i.player_id = _profile_id AND i.trainer_id IS NOT NULL
    UNION
    SELECT 'a:' || s.academy_profile_id::text FROM public.bookings b
      JOIN public.availability_slots s ON s.id = b.slot_id
      WHERE b.player_id = _profile_id AND s.academy_profile_id IS NOT NULL
    UNION
    SELECT 't:' || s.trainer_id::text FROM public.bookings b
      JOIN public.availability_slots s ON s.id = b.slot_id
      WHERE b.player_id = _profile_id AND s.trainer_id IS NOT NULL
  ) orgs
  WHERE orgs.org <> 'a:' || _academy_profile_id::text;
  IF v_other_orgs > 0 THEN
    RETURN 'override';
  END IF;

  -- truly nascent account: never logged in AND never confirmed. If the JOIN finds
  -- no row (shouldn't happen — profiles.user_id is NOT NULL), v_never_logged_in
  -- stays NULL -> coalesce false -> 'override' (conservative).
  SELECT (u.last_sign_in_at IS NULL AND u.email_confirmed_at IS NULL) INTO v_never_logged_in
  FROM public.profiles pr
  JOIN auth.users u ON u.id = pr.user_id
  WHERE pr.id = _profile_id;
  IF NOT coalesce(v_never_logged_in, false) THEN
    RETURN 'override';
  END IF;

  RETURN 'direct';
END;
$$;

-- (3) keep override emails well-formed (existing rows are all NULL, so this validates).
ALTER TABLE public.academy_player_metadata
  DROP CONSTRAINT IF EXISTS academy_player_metadata_billing_email_valid;
ALTER TABLE public.academy_player_metadata
  ADD CONSTRAINT academy_player_metadata_billing_email_valid
  CHECK (billing_email IS NULL OR billing_email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$');
