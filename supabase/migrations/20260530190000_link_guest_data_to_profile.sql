-- Phase 1: Reusable idempotent guest → profile linking for player portal visibility.
-- Populates bookings.player_id and invoices.player_id from guest_player_id matches;
-- sets guest_players.linked_profile_id on email match. Never overwrites non-null player_id.

CREATE OR REPLACE FUNCTION public.link_guest_data_to_profile(_profile_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile_email text;
  v_guest_players_linked integer := 0;
  v_bookings_linked integer := 0;
  v_invoices_linked integer := 0;
BEGIN
  SELECT nullif(trim(p.email), '')
  INTO v_profile_email
  FROM public.profiles p
  WHERE p.id = _profile_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'profile_id', _profile_id,
      'guest_players_linked', 0,
      'bookings_linked', 0,
      'invoices_linked', 0
    );
  END IF;

  -- Bookings: guest matches this profile (explicit link or email), player_id not yet set
  WITH matching_guests AS (
    SELECT gp.id
    FROM public.guest_players gp
    WHERE gp.linked_profile_id = _profile_id
       OR (
         gp.linked_profile_id IS NULL
         AND nullif(trim(gp.email), '') IS NOT NULL
         AND v_profile_email IS NOT NULL
         AND lower(trim(gp.email)) = lower(v_profile_email)
       )
  )
  UPDATE public.bookings b
  SET player_id = _profile_id
  FROM matching_guests mg
  WHERE b.guest_player_id = mg.id
    AND b.player_id IS NULL;

  GET DIAGNOSTICS v_bookings_linked = ROW_COUNT;

  -- Invoices: same guest match rules
  WITH matching_guests AS (
    SELECT gp.id
    FROM public.guest_players gp
    WHERE gp.linked_profile_id = _profile_id
       OR (
         gp.linked_profile_id IS NULL
         AND nullif(trim(gp.email), '') IS NOT NULL
         AND v_profile_email IS NOT NULL
         AND lower(trim(gp.email)) = lower(v_profile_email)
       )
  )
  UPDATE public.invoices i
  SET player_id = _profile_id
  FROM matching_guests mg
  WHERE i.guest_player_id = mg.id
    AND i.player_id IS NULL;

  GET DIAGNOSTICS v_invoices_linked = ROW_COUNT;

  -- Guest row: set linked_profile_id only when unset and email matches profile
  IF v_profile_email IS NOT NULL THEN
    UPDATE public.guest_players gp
    SET linked_profile_id = _profile_id
    WHERE gp.linked_profile_id IS NULL
      AND nullif(trim(gp.email), '') IS NOT NULL
      AND lower(trim(gp.email)) = lower(v_profile_email);

    GET DIAGNOSTICS v_guest_players_linked = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object(
    'profile_id', _profile_id,
    'guest_players_linked', v_guest_players_linked,
    'bookings_linked', v_bookings_linked,
    'invoices_linked', v_invoices_linked
  );
END;
$$;

COMMENT ON FUNCTION public.link_guest_data_to_profile(uuid) IS
  'Links guest-origin bookings/invoices to a profile (player_id). Idempotent; never overwrites player_id.';

-- Profile signup: delegate linking, keep player role + trainer follow side effects
CREATE OR REPLACE FUNCTION public.link_guest_invoices_on_signup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _result jsonb;
  _linked boolean := false;
  _guest record;
BEGIN
  _result := public.link_guest_data_to_profile(NEW.id);

  _linked :=
    coalesce((_result->>'bookings_linked')::integer, 0) > 0
    OR coalesce((_result->>'invoices_linked')::integer, 0) > 0
    OR coalesce((_result->>'guest_players_linked')::integer, 0) > 0;

  IF _linked THEN
    INSERT INTO public.user_roles (user_id, role)
    VALUES (NEW.user_id, 'player')
    ON CONFLICT (user_id, role) DO NOTHING;
  END IF;

  FOR _guest IN
    SELECT DISTINCT gp.trainer_id
    FROM public.guest_players gp
    WHERE gp.linked_profile_id = NEW.id
      AND gp.trainer_id IS NOT NULL
  LOOP
    INSERT INTO public.trainer_followers (player_id, trainer_id)
    VALUES (NEW.id, _guest.trainer_id)
    ON CONFLICT DO NOTHING;
  END LOOP;

  RETURN NEW;
END;
$$;

-- Guest insert/update: link when staff sets linked_profile_id or email matches a profile
CREATE OR REPLACE FUNCTION public.link_guest_data_on_guest_player_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _profile record;
BEGIN
  IF NEW.linked_profile_id IS NOT NULL THEN
    PERFORM public.link_guest_data_to_profile(NEW.linked_profile_id);
  END IF;

  -- Email path only when guest is not explicitly linked to a different profile
  IF NEW.linked_profile_id IS NULL
     AND nullif(trim(NEW.email), '') IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.email IS DISTINCT FROM OLD.email)
  THEN
    FOR _profile IN
      SELECT p.id
      FROM public.profiles p
      WHERE nullif(trim(p.email), '') IS NOT NULL
        AND lower(trim(p.email)) = lower(trim(NEW.email))
    LOOP
      PERFORM public.link_guest_data_to_profile(_profile.id);
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_link_guest_data_on_guest_player_change ON public.guest_players;

CREATE TRIGGER trg_link_guest_data_on_guest_player_change
  AFTER INSERT OR UPDATE OF linked_profile_id, email
  ON public.guest_players
  FOR EACH ROW
  EXECUTE FUNCTION public.link_guest_data_on_guest_player_change();
