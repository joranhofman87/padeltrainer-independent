-- Allow families to share one email address across multiple player records.
--
-- Drops the per-scope unique email indexes on guest_players (and club_players)
-- and replaces them with plain lookup indexes. With shared emails legitimate,
-- email-based automation must stop assuming one-email-one-player:
-- link_guest_data_to_profile now applies its EMAIL-match path only when
-- exactly ONE unlinked guest matches the profile's email — ambiguous emails
-- (siblings sharing a parent address) link nothing automatically and are left
-- for the academy to link or merge manually. Explicitly linked guests
-- (linked_profile_id already set) keep linking their bookings/invoices as
-- before. Auth accounts are unaffected (Supabase Auth emails stay unique).

-- ---- uniqueness -> plain lookup indexes ----
DROP INDEX IF EXISTS public.idx_guest_players_trainer_email_unique;
DROP INDEX IF EXISTS public.idx_guest_players_academy_email_unique;
ALTER TABLE public.club_players DROP CONSTRAINT IF EXISTS unique_club_player_email;
DROP INDEX IF EXISTS public.unique_club_player_email;

CREATE INDEX IF NOT EXISTS idx_guest_players_trainer_email
  ON public.guest_players (trainer_id, email)
  WHERE email IS NOT NULL AND email <> '';
CREATE INDEX IF NOT EXISTS idx_guest_players_academy_email
  ON public.guest_players (academy_profile_id, email)
  WHERE email IS NOT NULL AND email <> '';
CREATE INDEX IF NOT EXISTS idx_club_players_club_email
  ON public.club_players (club_profile_id, email);

-- ---- single-match guard on the email auto-linker ----
CREATE OR REPLACE FUNCTION public.link_guest_data_to_profile(_profile_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile_email text;
  v_email_match_ids uuid[];
  v_email_match_id uuid;  -- set only when EXACTLY one unlinked guest matches
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

  -- Email matching is only safe when unambiguous: with shared family emails,
  -- multiple unlinked guests may carry the profile's address — linking them
  -- all would attach every sibling to one account.
  IF v_profile_email IS NOT NULL THEN
    SELECT array_agg(sub.id) INTO v_email_match_ids
    FROM (
      SELECT gp.id
      FROM public.guest_players gp
      WHERE gp.linked_profile_id IS NULL
        AND nullif(trim(gp.email), '') IS NOT NULL
        AND lower(trim(gp.email)) = lower(v_profile_email)
      LIMIT 2
    ) sub;
    IF coalesce(array_length(v_email_match_ids, 1), 0) = 1 THEN
      v_email_match_id := v_email_match_ids[1];
    END IF;
  END IF;

  -- Bookings: explicitly linked guests + the (single) email match
  WITH matching_guests AS (
    SELECT gp.id
    FROM public.guest_players gp
    WHERE gp.linked_profile_id = _profile_id
       OR gp.id = v_email_match_id
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
       OR gp.id = v_email_match_id
  )
  UPDATE public.invoices i
  SET player_id = _profile_id
  FROM matching_guests mg
  WHERE i.guest_player_id = mg.id
    AND i.player_id IS NULL;

  GET DIAGNOSTICS v_invoices_linked = ROW_COUNT;

  -- Guest row: link only the unambiguous single email match
  IF v_email_match_id IS NOT NULL THEN
    UPDATE public.guest_players gp
    SET linked_profile_id = _profile_id
    WHERE gp.id = v_email_match_id
      AND gp.linked_profile_id IS NULL;

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
  'Links guest-origin bookings/invoices to a profile (player_id). Email matching applies only when exactly one unlinked guest matches (shared family emails link nothing automatically). Idempotent; never overwrites player_id.';
