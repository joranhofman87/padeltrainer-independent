-- U2 — the club student list is keyed on the Player, not on their address.
--
-- `addToClubStudentList` selected `club_players` by (club, email) and returned on a hit, so two
-- people who share an address produced ONE roster row: the second registrant was silently never
-- added to the club's student list. That is attribute-based deduplication of a person, which the
-- owner's rule names explicitly alongside select, merge and reuse.
--
-- WHY THIS IS A SERVER COMMAND and not a corrected client query. The client held three things it
-- had no right to be trusted with: which Player this is (a uuid it supplied), which club to write
-- into (an id it supplied), and whether a row already existed (a read it raced). Each is now
-- derived or checked here:
--
--   * the PLAYER must be the caller's own profile. A supplied uuid is not authorization; it names
--     the subject, and `auth.uid()` decides whether the caller may speak for it.
--   * the CLUB comes from the REGISTRATION being signed up to, which is a trusted row. A caller
--     cannot redirect their sign-up into a club whose form they did not fill in.
--   * the EXISTENCE CHECK happens under an advisory lock on (club, person), so two concurrent
--     retries of one registration produce one row rather than two.
--
-- WHAT IS DELIBERATELY NOT DONE. No production rows are cleaned up, merged or backfilled: legacy
-- rows carry a NULL `person_id` and stay exactly as they are. No UNIQUE constraint is added on
-- (club, person) either — the column is empty on every existing row, so a unique index could only
-- be proven safe by a preflight over production data, which this branch does not do. The advisory
-- lock is what makes NEW writes single, and it needs no constraint to work.

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- The canonical identity, alongside the legacy columns
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.club_players
  ADD COLUMN IF NOT EXISTS person_id uuid REFERENCES public.persons(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_club_players_club_person
  ON public.club_players (club_profile_id, person_id);

COMMENT ON COLUMN public.club_players.person_id IS
  'Canonical Player identity for this roster row. NULL on every row written before U2 — those are left exactly as they were, so a Player who predates this may be listed twice rather than have two people quietly merged into one.';

-- A club roster entry for a Player with no address. `guest_players.email` has always been
-- nullable; this column was not, which made the club list the one place a Player had to have one.
ALTER TABLE public.club_players ALTER COLUMN email DROP NOT NULL;

COMMENT ON COLUMN public.club_players.email IS
  'Contact address, optional since U2 — a Player is not required to have one. It is contact information and never an identity key: `person_id` is what says who this is.';

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- The command
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.club_student_list_add(
  _registration_id uuid,
  _profile_id      uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_profile public.profiles%ROWTYPE;
  v_owner_type text;
  v_club uuid;
  v_person uuid;
  v_existing uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'CLUB_STUDENT_NOT_AUTHENTICATED' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- 1. WHICH PLAYER. The uuid names the subject; the token decides whether the caller may act as
  --    them. This is a self-registration path, so the only Player a caller may add is themselves.
  SELECT * INTO v_profile FROM public.profiles p
   WHERE p.id = _profile_id AND p.user_id = v_uid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CLUB_STUDENT_NOT_YOUR_PLAYER: you can only add yourself to a club student list'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- 2. WHICH CLUB. From the registration, never from the caller — otherwise a sign-up to one club's
  --    form could be redirected into another club's roster.
  SELECT r.owner_type, r.owner_id INTO v_owner_type, v_club
    FROM public.registrations r WHERE r.id = _registration_id;
  IF v_owner_type IS NULL THEN
    RAISE EXCEPTION 'CLUB_STUDENT_NO_REGISTRATION: no such registration'
      USING ERRCODE = 'no_data_found';
  END IF;
  IF v_owner_type <> 'club' THEN
    RAISE EXCEPTION 'CLUB_STUDENT_NOT_A_CLUB_REGISTRATION: that form is not owned by a club'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- 3. WHO THEY ARE, canonically.
  SELECT pl.person_id INTO v_person FROM public.person_links pl WHERE pl.profile_id = _profile_id;
  IF v_person IS NULL THEN
    RAISE EXCEPTION 'CLUB_STUDENT_NO_PERSON: that Player has no canonical identity yet'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- 4. One row per (club, Player). The lock is what makes that true for concurrent retries; there
  --    is no unique index to lean on, deliberately (see the header).
  PERFORM pg_advisory_xact_lock(hashtext('club_student:' || v_club::text || ':' || v_person::text));

  SELECT cp.id INTO v_existing
    FROM public.club_players cp
   WHERE cp.club_profile_id = v_club AND cp.person_id = v_person
   LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;   -- the SAME canonical Player, and nothing else can match
  END IF;

  -- 5. The row. Its details come from the authorized profile rather than from the submission: the
  --    caller has already been proven to be this person, and their own record is the better source
  --    than whatever was typed into a form field.
  INSERT INTO public.club_players (
    club_profile_id, person_id, full_name, email, phone,
    skill_rating, rating_system, linked_profile_id, source, has_trained
  ) VALUES (
    v_club, v_person,
    coalesce(nullif(btrim(v_profile.full_name), ''), 'Unknown'),
    nullif(btrim(v_profile.email), ''),
    nullif(btrim(v_profile.phone), ''),
    v_profile.skill_rating,
    coalesce(nullif(btrim(v_profile.rating_system), ''), 'knltb'),
    -- resolved from the relationship this function just authorized, never from an argument
    _profile_id,
    'cycle_registration', false
  )
  RETURNING id INTO v_existing;

  RETURN v_existing;
END;
$$;

REVOKE ALL ON FUNCTION public.club_student_list_add(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.club_student_list_add(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.club_student_list_add(uuid, uuid) IS
  'Adds the CALLER to a club student list, once per canonical Player. The club comes from the registration and the Player must be the caller''s own profile — a supplied uuid names a subject, never grants permission. Replaces a client-side select-by-email that merged two people who shared an address (U2, owner 2026-08-09).';

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- The direct client write STAYS, and the reason is written down rather than assumed
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- The obsolete route this replaces is the self-registration insert in `addToClubStudentList`, which
-- is gone from the client. INSERT on `club_players` is NOT revoked, because the call-graph
-- inventory does not support it: `addClubPlayer` in `src/lib/club.ts` is a club manager adding
-- somebody to their OWN roster from `ClubPlayers.tsx`, and it is a live route with a different
-- authorization story (the manager owns the club; there is no self-registration involved). Revoking
-- the privilege would break it. Narrowing that path to a command of its own is a separate piece of
-- work with its own decisions, and pretending otherwise by revoking now would just move the
-- breakage somewhere less visible.
