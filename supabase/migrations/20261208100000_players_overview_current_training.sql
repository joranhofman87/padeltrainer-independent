-- PTF-OPTION-A (2026-09-27) — Academy Players: "currently training" + "training club" filters and a
-- contact export — with academy membership A1 and the one-call export E1 (Tom, 2026-09-29).
--
-- WHAT (three functions; nothing else changes):
--   1. players_private.players_overview_rows — the ONE private filter authority. It computes the
--      membership universe (A1 below), the person rollup, search, every filter (including the two
--      PTF training keys), the sort and one window of rows. It is not reachable by any client role:
--      the schema grants no USAGE and the function no EXECUTE to PUBLIC, anon, authenticated or
--      service_role. SECURITY INVOKER (it runs with the rights of the public entry that calls it),
--      STABLE, pinned search_path, every reference schema-qualified, and it re-checks the caller's
--      authorization itself (defence in depth).
--   2. public.get_players_overview — same signature, return type and ACL. It authorizes the caller,
--      then returns one page of the authority's rows with the page-only enrichment (trainer / club
--      chips, active cycle, overdue payment, undeliverable email).
--   3. public.get_players_overview_export(p_academy, p_search, p_filters, p_sort, p_sort_dir) —
--      academy scope only. One row: `total` and `rows`, a jsonb array of
--      {person_id, full_name, email, phone} for EVERY matching person in list order, from ONE
--      evaluation of the authority. More than 20,000 matches is refused (SQLSTATE 54000; DETAIL
--      "total=<n> max=20000"). EXECUTE: owner + authenticated only.
--   All three: STABLE; the entries are SECURITY DEFINER; search_path = pg_catalog, pg_temp.
--
-- A1 — ACADEMY MEMBERSHIP (academy scope only). The previous universe admitted people through the
--   academy's active TRAINERS: every slot of a shared trainer (another academy's sessions, the
--   trainer's own practice) and every guest a shared trainer owns. That is the cross-tenant path the
--   owner closed on the RLS side in 20260706130100; this function never received the fix. Now a side
--   is in academy A's universe iff:
--     guest side:      guest_players.academy_profile_id = A, OR a confirmed/completed booking on a
--                      session with availability_slots.academy_profile_id = A, OR an
--                      academy_player_metadata row of A links the guest;
--     registered side: a confirmed/completed booking on a session with academy_profile_id = A
--                      (first_booking_at is derived from that same set).
--   Every booking-derived filter and chip (trainer activity, trained clubs, active cycle) reads the
--   same academy-owned sessions (scope_slots). Unchanged: the person rollup, split-freeze, removal,
--   search, sort, paging, the metadata overlay, and TRAINER scope (the trainer's own guests and
--   sessions) in full. Unstamped sessions (academy_profile_id NULL) admit nobody to an academy;
--   nothing is repaired or inferred here.
--   Residual: booking-derived admission is only as trustworthy as booking-subject integrity (ABC-17,
--   a separate gate). A1 is strictly narrower than the trainer union: a forged booking can add a
--   person only to the academy that owns the session.
--
-- THE QUALIFYING SESSION — one predicate (CTE training_now) drives BOTH training keys, so the
-- current-training filter, the training-club filter and the export built on them cannot disagree.
-- A booking b on slot s makes its person "currently training at this academy" iff ALL of:
--   (1) s.academy_profile_id = the academy. Direct session ownership only: a shared trainer's sessions
--       for another academy, or for their own practice, never count, and nothing is inferred from
--       trainer membership, preferred/intake/manual clubs, payments or registrations.
--   (2) b.status IN ('confirmed','completed') — the overview's own membership statuses. Pending,
--       cancelled and every other status never count.
--   (3) s.end_time >= now(): the session is in progress or still ahead. This is the overview's existing
--       "remaining" boundary (a session ending exactly now still counts). There is NO future horizon.
--   (4) s.cyclus_id IS NULL — a standalone session, upcoming or in progress — OR the session's cycle has
--       STARTED: some academy-owned session of that cycle has start_time < now(). The app's own
--       "not yet started" rule is start_time >= now() (CycleDetailView), so a cycle whose every session
--       still lies ahead does NOT count, even though the person is booked into it (Tom's option A:
--       ongoing cycles + upcoming standalone sessions; cycles that have not started are excluded).
--   Consequence of (3)+(4b): a person in a started cycle counts while they still hold a qualifying
--   booking on one of its remaining sessions; someone whose remaining bookings were all cancelled
--   (dropped out) does not.
--   Person matching uses the overview's REF-SET rule (the person's guest refs, or a pure-profile
--   booking), so the result stays one row per canonical person.
--
-- KEYS
--   current_training      boolean. NULL = no filter; true / false = has / has no qualifying session.
--   training_location_id  uuid. The person has a qualifying session whose slot location (a merged
--                         location resolved to its canonical club) is this club. This is NOT the
--                         existing location_id chip filter, which keeps its historical / preferred /
--                         intake semantics; has_active_cyclus keeps its meaning too.
--   Academy scope only: either key with p_scope = 'trainer' is refused (SQLSTATE 22023).
--
-- ORDER: the authority numbers its rows from ONE window definition (w_sort); a list page and the export
--   are both read in that order, so they can never order differently.
-- SNAPSHOT: every function in the chain is STABLE, so PostgreSQL runs each of them with the calling
--   statement's snapshot, and the export is ONE client statement: its total and its rows describe one
--   database state, whatever commits while it runs (src/test/ptfReleasePacket.realpg.test.ts proves it
--   with a commit made mid-call). now() is the call's transaction time.
--
-- COMPOSITION — a RELEASE gate, recorded here, not acted on here:
--   security/abc16-metadata-authority-containment (20261118110000, unmerged) also CREATE OR REPLACEs
--   get_players_overview, from the pre-person-unification body with direct-ownership-only membership
--   and no registered/person admission. A1 adopts its containment invariants (no trainer-union
--   admission; ownership by academy_profile_id) and keeps registered and canonical-person admission,
--   which U2 and this feature require. Whichever lands second MUST be rebuilt on the other's full
--   body, and ABC-16's "no registered admission" needs a fresh owner decision first.
--
-- VERSION 20261208100000 IS PROVISIONAL: it must apply after the ACL correction (20261207100000) and
--   before any later-applied lane; it is re-allocated at release composition.

CREATE SCHEMA IF NOT EXISTS players_private;
REVOKE ALL ON SCHEMA players_private FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION players_private.players_overview_rows(
  p_scope text,                       -- 'academy' | 'trainer'
  p_scope_id uuid,
  p_search text,
  p_filters jsonb,
  p_sort text,                        -- 'name' | 'email' | 'skill' | 'created_at'
  p_sort_dir text,
  p_limit integer,                    -- rows to return, >= 1 (each entry sets its own bound)
  p_offset integer,                   -- rows to skip, >= 0
  p_enrich boolean                    -- compute the page-only enrichment columns (the list) or not
)
RETURNS TABLE (
  player_key text,
  player_type text,
  guest_player_id uuid,
  profile_id uuid,
  person_id uuid,
  full_name text,
  email text,
  phone text,
  billing_business_name text,
  billing_address text,
  billing_btw_number text,
  skill_rating numeric,
  rating_system text,
  notes text,
  source text,
  birth_date date,
  has_trained boolean,
  created_at timestamptz,
  owner_trainer_id uuid,
  metadata_id uuid,
  tag_ids uuid[],
  academy_notes text,
  trainer_ids uuid[],
  location_ids uuid[],
  location_names text[],
  has_active_cyclus boolean,
  has_overdue_payment boolean,
  email_undeliverable boolean,
  total_count bigint,
  sort_ord bigint
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tokens text[];
  v_filter_trainer uuid    := nullif(p_filters->>'trainer_id','')::uuid;
  v_filter_location uuid   := nullif(p_filters->>'location_id','')::uuid;
  v_level_gt numeric       := (p_filters->>'level_gt')::numeric;   -- exclusive lower bound
  v_level_max numeric      := (p_filters->>'level_max')::numeric;  -- inclusive upper bound
  v_level_unrated boolean  := coalesce((p_filters->>'level_unrated')::boolean, false);
  v_has_cyclus boolean     := (p_filters->>'has_active_cyclus')::boolean;  -- NULL = no filter
  v_current_training boolean := (p_filters->>'current_training')::boolean;   -- NULL = no filter
  v_training_location uuid   := nullif(p_filters->>'training_location_id','')::uuid;
  v_tag text               := nullif(p_filters->>'tag_id','');             -- uuid text | 'untagged'
  v_payment text           := nullif(p_filters->>'payment','');            -- 'overdue' | 'ok'
BEGIN
  -- ---- authorization, re-checked here: each public entry has already checked it (defence in depth;
  -- this function reads without RLS under its caller's owner rights) ----
  IF p_scope = 'academy' THEN
    IF NOT public.is_academy_manager(auth.uid(), p_scope_id) THEN
      RAISE EXCEPTION 'not authorized for academy %', p_scope_id USING ERRCODE = '42501';
    END IF;
  ELSIF p_scope = 'trainer' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.trainer_profiles tp
       WHERE tp.id = p_scope_id AND tp.user_id = auth.uid()
    ) THEN
      RAISE EXCEPTION 'not authorized for trainer %', p_scope_id USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid scope: %', p_scope;
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_offset IS NULL OR p_offset < 0 OR p_enrich IS NULL THEN
    RAISE EXCEPTION 'invalid window (limit %, offset %, enrich %)', p_limit, p_offset, p_enrich
      USING ERRCODE = '22023';
  END IF;

  -- The training keys answer "trains at THIS academy" (academy-owned sessions); they have no
  -- trainer-scope meaning, so asking for one there is refused rather than silently ignored.
  IF p_scope <> 'academy' AND (v_current_training IS NOT NULL OR v_training_location IS NOT NULL) THEN
    RAISE EXCEPTION 'current_training / training_location_id are academy-scope filters' USING ERRCODE = '22023';
  END IF;

  IF coalesce(btrim(p_search), '') <> '' THEN
    v_tokens := regexp_split_to_array(public.fold_search_text(btrim(p_search)), '\s+');
  END IF;

  RETURN QUERY
  -- The sessions in scope. A1: an academy's own sessions only (never a shared trainer's other
  -- sessions); trainer scope: the trainer's sessions, as before.
  WITH scope_slots AS (
    SELECT s.id, s.trainer_id, s.location_id, s.cyclus_id, s.end_time
    FROM public.availability_slots s
    WHERE p_scope = 'academy' AND s.academy_profile_id = p_scope_id
    UNION ALL
    SELECT s.id, s.trainer_id, s.location_id, s.cyclus_id, s.end_time
    FROM public.availability_slots s
    WHERE p_scope = 'trainer' AND s.trainer_id = p_scope_id
  ),
  -- PTF-OPTION-A: the ONE qualifying-session predicate (see the header). Both training keys read
  -- only this CTE, so the current-training filter, the training-club filter and the export built
  -- on them cannot disagree. Computed only when a training key is set; bounded to the academy's
  -- in-progress/remaining sessions. Columns are t_-prefixed: OUT params share the bare names.
  training_now AS (
    SELECT b.guest_player_id AS t_guest_id,
           b.player_id       AS t_player_id,
           coalesce(tl.merged_into, s.location_id) AS t_location_id
    FROM public.availability_slots s
    JOIN public.bookings b ON b.slot_id = s.id
    LEFT JOIN public.locations tl ON tl.id = s.location_id
    WHERE p_scope = 'academy'
      AND (v_current_training IS NOT NULL OR v_training_location IS NOT NULL)
      AND s.academy_profile_id = p_scope_id              -- (1) academy-owned session only
      AND b.status IN ('confirmed','completed')          -- (2) qualifying booking
      AND s.end_time >= now()                            -- (3) in progress or ahead, no horizon
      AND (s.cyclus_id IS NULL                           -- (4a) standalone session
        OR EXISTS (                                      -- (4b) its cycle has started
             SELECT 1 FROM public.availability_slots s0
             WHERE s0.cyclus_id = s.cyclus_id
               AND s0.academy_profile_id = p_scope_id
               AND s0.start_time < now()))
  ),
  removed_meta AS (
    SELECT m.guest_player_id AS gid, m.profile_id AS pid
    FROM public.academy_player_metadata m
    WHERE m.removed_at IS NOT NULL
      AND ((p_scope = 'academy' AND m.academy_profile_id  = p_scope_id)
        OR (p_scope = 'trainer' AND m.trainer_profile_id = p_scope_id))
  ),
  -- The guest sides in scope. A1 (academy): owned by the academy, OR a confirmed/completed booking on
  -- one of its sessions, OR linked by one of its metadata rows — the owner's relationship rule
  -- (20260706130100). Trainer scope: the trainer's own guests, as before.
  guest_refs AS (
    SELECT g.id AS gr_id
    FROM public.guest_players g
    WHERE p_scope = 'academy' AND g.academy_profile_id = p_scope_id
    UNION
    SELECT b.guest_player_id
    FROM public.bookings b
    JOIN scope_slots ss ON ss.id = b.slot_id
    WHERE p_scope = 'academy' AND b.guest_player_id IS NOT NULL
      AND b.status IN ('confirmed','completed')
    UNION
    SELECT m.guest_player_id
    FROM public.academy_player_metadata m
    WHERE p_scope = 'academy' AND m.academy_profile_id = p_scope_id AND m.guest_player_id IS NOT NULL
    UNION
    SELECT g.id
    FROM public.guest_players g
    WHERE p_scope = 'trainer' AND g.trainer_id = p_scope_id
  ),
  guests AS (
    SELECT g.*
    FROM public.guest_players g
    JOIN guest_refs gr ON gr.gr_id = g.id
    WHERE NOT EXISTS (SELECT 1 FROM removed_meta rm WHERE rm.gid = g.id)
  ),
  -- Registered sides: any in-scope booking with player_id set (dual-keyed included); in scope = on a
  -- scope_slots session (A1: the academy's own sessions).
  registered AS (
    SELECT b.player_id AS pid, min(b.created_at) AS first_booking_at
    FROM public.bookings b
    JOIN scope_slots ss ON ss.id = b.slot_id
    WHERE b.player_id IS NOT NULL
      AND b.status IN ('confirmed','completed')
    GROUP BY b.player_id
  ),
  registered_visible AS (
    SELECT r.pid, r.first_booking_at
    FROM registered r
    WHERE NOT EXISTS (SELECT 1 FROM removed_meta rm WHERE rm.pid = r.pid)
  ),
  -- one row per IN-SCOPE SIDE (guest / registered profile), person-resolved. A frozen or
  -- unlinked guest keys as ITSELF; a profile without a link keys as itself (deterministic
  -- person ids make both congruent with their eventual person row).
  sided AS (
    SELECT
      g.id                                                        AS s_guest_player_id,
      NULL::uuid                                                  AS s_profile_id,
      CASE WHEN pl.person_id IS NOT NULL AND NOT public.is_guest_split_frozen(g.id)
           THEN pl.person_id ELSE g.id END                        AS s_person_id,
      coalesce(nullif(btrim(g.full_name), ''), 'Unknown')         AS s_full_name,
      coalesce(g.email, '')                                       AS s_email,
      coalesce(g.phone, '')                                       AS s_phone,
      g.billing_business_name                                     AS s_billing_business_name,
      g.billing_address                                           AS s_billing_address,
      g.billing_btw_number                                        AS s_billing_btw_number,
      g.skill_rating                                              AS s_skill_rating,
      coalesce(nullif(g.rating_system, ''), 'knltb')              AS s_rating_system,
      g.notes                                                     AS s_notes,
      g.source                                                    AS s_source,
      g.birth_date                                                AS s_birth_date,
      coalesce(g.has_trained, false)                              AS s_has_trained,
      g.created_at                                                AS s_created_at,
      g.trainer_id                                                AS s_owner_trainer_id
    FROM guests g
    LEFT JOIN public.person_links pl ON pl.guest_player_id = g.id
    UNION ALL
    SELECT
      NULL::uuid, p.id, coalesce(pl.person_id, p.id),
      coalesce(nullif(btrim(p.full_name), ''), 'Unknown'),
      coalesce(p.email, ''), coalesce(p.phone, ''),
      p.billing_business_name, p.billing_address, p.billing_btw_number,
      p.skill_rating, coalesce(nullif(p.rating_system, ''), 'knltb'),
      NULL, NULL, p.birth_date, true, rv.first_booking_at, NULL::uuid
    FROM registered_visible rv
    JOIN public.profiles p ON p.id = rv.pid
    LEFT JOIN public.person_links pl ON pl.profile_id = p.id
  ),
  -- Person-level REMOVAL: for a merged person, removing ANY in-scope side removes the HUMAN
  -- (one row = one human, so "Delete" must not leave the person re-rendering under a secondary
  -- ref). Unmerged rows are unaffected: their removed side never enters `sided` anyway.
  removed_persons AS (
    -- rp_person_id: the OUT column person_id would make a bare reference ambiguous in plpgsql
    SELECT CASE WHEN pl.person_id IS NOT NULL AND NOT public.is_guest_split_frozen(rm.gid)
                THEN pl.person_id ELSE rm.gid END AS rp_person_id
    FROM removed_meta rm
    LEFT JOIN public.person_links pl ON pl.guest_player_id = rm.gid
    WHERE rm.gid IS NOT NULL
    UNION
    SELECT coalesce(pl.person_id, rm.pid)
    FROM removed_meta rm
    LEFT JOIN public.person_links pl ON pl.profile_id = rm.pid
    WHERE rm.pid IS NOT NULL
  ),
  -- PERSON rollup: one row per person. Side-field picks are guest-first (for a single-side
  -- person this IS that side's value, so unmerged rows render exactly as before). Every pick
  -- ends its ORDER BY on a unique column — created_at ties are real (bulk imports share one
  -- transaction timestamp) and would otherwise make player_key/identity plan-dependent.
  rolled AS (
    SELECT
      s.s_person_id                                               AS b_person_id,
      (count(*) > 1)                                              AS b_merged,
      bool_or(s.s_profile_id IS NOT NULL)                         AS b_has_login,
      (array_agg(s.s_guest_player_id ORDER BY s.s_created_at, s.s_guest_player_id)
         FILTER (WHERE s.s_guest_player_id IS NOT NULL))[1]       AS b_guest_player_id,
      array_remove(array_agg(s.s_guest_player_id), NULL)          AS b_guest_ids,
      -- at most one profile per person (one-profile-per-person index); no max(uuid) in PG
      (array_remove(array_agg(s.s_profile_id), NULL))[1]          AS b_profile_id,
      (array_agg(s.s_full_name  ORDER BY (s.s_guest_player_id IS NULL), s.s_created_at, s.s_guest_player_id))[1] AS b_full_name,
      coalesce((array_remove(array_agg(nullif(s.s_email, '')  ORDER BY (s.s_guest_player_id IS NULL), s.s_created_at, s.s_guest_player_id), NULL))[1], '') AS b_email,
      coalesce((array_remove(array_agg(nullif(s.s_phone, '')  ORDER BY (s.s_guest_player_id IS NULL), s.s_created_at, s.s_guest_player_id), NULL))[1], '') AS b_phone,
      (array_remove(array_agg(s.s_billing_business_name ORDER BY (s.s_guest_player_id IS NULL), s.s_created_at, s.s_guest_player_id), NULL))[1] AS b_billing_business_name,
      (array_remove(array_agg(s.s_billing_address       ORDER BY (s.s_guest_player_id IS NULL), s.s_created_at, s.s_guest_player_id), NULL))[1] AS b_billing_address,
      (array_remove(array_agg(s.s_billing_btw_number    ORDER BY (s.s_guest_player_id IS NULL), s.s_created_at, s.s_guest_player_id), NULL))[1] AS b_billing_btw_number,
      (array_remove(array_agg(s.s_skill_rating          ORDER BY (s.s_guest_player_id IS NULL), s.s_created_at, s.s_guest_player_id), NULL))[1] AS b_skill_rating,
      (array_agg(s.s_rating_system ORDER BY (s.s_guest_player_id IS NULL), s.s_created_at, s.s_guest_player_id))[1] AS b_rating_system,
      (array_remove(array_agg(s.s_notes  ORDER BY (s.s_guest_player_id IS NULL), s.s_created_at, s.s_guest_player_id), NULL))[1] AS b_notes,
      (array_remove(array_agg(s.s_source ORDER BY (s.s_guest_player_id IS NULL), s.s_created_at, s.s_guest_player_id), NULL))[1] AS b_source,
      (array_remove(array_agg(s.s_birth_date ORDER BY (s.s_guest_player_id IS NULL), s.s_created_at, s.s_guest_player_id), NULL))[1] AS b_birth_date,
      bool_or(s.s_has_trained)                                    AS b_has_trained,
      min(s.s_created_at)                                         AS b_created_at,
      (array_remove(array_agg(s.s_owner_trainer_id ORDER BY (s.s_guest_player_id IS NULL), s.s_created_at, s.s_guest_player_id), NULL))[1] AS b_owner_trainer_id,
      -- ALL owner trainers across the person's in-scope guests — the trainer filter and the
      -- trainer_ids chips must see every ref's owner, not just the primary's
      (SELECT coalesce(array_agg(DISTINCT t), '{}'::uuid[])
         FROM unnest(array_remove(array_agg(s.s_owner_trainer_id), NULL)) t) AS b_owner_trainer_ids,
      -- the IN-SCOPE PROFILE side's identity (merged rows prefer it below — profile-first
      -- precedence like rederive, but strictly from data THIS SCOPE already sees)
      (array_remove(array_agg(nullif(s.s_email, '') ) FILTER (WHERE s.s_profile_id IS NOT NULL), NULL))[1] AS b_prof_email,
      (array_remove(array_agg(nullif(s.s_phone, '') ) FILTER (WHERE s.s_profile_id IS NOT NULL), NULL))[1] AS b_prof_phone,
      (array_remove(array_agg(s.s_billing_business_name) FILTER (WHERE s.s_profile_id IS NOT NULL), NULL))[1] AS b_prof_billing_business_name,
      (array_remove(array_agg(s.s_billing_address)       FILTER (WHERE s.s_profile_id IS NOT NULL), NULL))[1] AS b_prof_billing_address,
      (array_remove(array_agg(s.s_billing_btw_number)    FILTER (WHERE s.s_profile_id IS NOT NULL), NULL))[1] AS b_prof_billing_btw_number,
      (array_remove(array_agg(s.s_skill_rating)          FILTER (WHERE s.s_profile_id IS NOT NULL), NULL))[1] AS b_prof_skill_rating,
      (array_remove(array_agg(nullif(s.s_rating_system, '')) FILTER (WHERE s.s_profile_id IS NOT NULL), NULL))[1] AS b_prof_rating_system,
      (array_remove(array_agg(s.s_birth_date)            FILTER (WHERE s.s_profile_id IS NOT NULL), NULL))[1] AS b_prof_birth_date,
      -- every side identity stays SEARCHABLE (a trainer who only knows the roster-side
      -- name/email must still find the merged human) …
      string_agg(s.s_full_name || ' ' || s.s_email || ' ' || s.s_phone
                 || ' ' || coalesce(s.s_billing_business_name, ''), ' ') AS b_search_sides,
      -- … and every side email still counts for deliverability (invoices to the guest seat
      -- keep going to the guest-side address)
      array_remove(array_agg(nullif(lower(btrim(s.s_email)), '')), NULL) AS b_all_emails
    FROM sided s
    WHERE s.s_person_id NOT IN (SELECT rp.rp_person_id FROM removed_persons rp)
    GROUP BY s.s_person_id
  ),
  -- Merged rows render the person's identity: full_name from persons (the rederive choke
  -- point — the SAME name the cycle-detail roster shows since 3.1); all OTHER identity fields
  -- prefer the IN-SCOPE profile side over the guest-first pick. Deliberately NOT the persons
  -- row's contact/billing fields: persons aggregates sides SYSTEM-WIDE, and a reader keyed to
  -- one academy's scope must never surface a profile's (or another tenant's guest's) contact
  -- data that this scope could not already see on its own rows.
  base AS (
    SELECT
      r.b_person_id,
      CASE WHEN r.b_guest_player_id IS NOT NULL
           THEN 'g_' || r.b_guest_player_id::text
           ELSE 'p_' || r.b_profile_id::text END                  AS b_player_key,
      -- Phase 3.3e: 'registered' = the PERSON has a login (persons.user_id), NOT merely 'a profile
      -- side is in scope'. Fixes the mislabel where a login holder who only ever attended as a GUEST
      -- (no in-scope player_id booking → no profile side in `sided` → b_has_login false) showed as
      -- 'guest'. Consistent with the roster (3.3a) + detail (3.3d) has_login. A split-frozen guest
      -- keys as its own accountless person → 'guest'.
      CASE WHEN coalesce((SELECT pe2.user_id IS NOT NULL FROM public.persons pe2 WHERE pe2.id = r.b_person_id), false)
           THEN 'registered' ELSE 'guest' END                      AS b_player_type,
      r.b_guest_player_id,
      r.b_guest_ids,
      r.b_profile_id,
      CASE WHEN r.b_merged THEN coalesce(nullif(btrim(pe.full_name), ''), r.b_full_name) ELSE r.b_full_name END AS b_full_name,
      CASE WHEN r.b_merged THEN coalesce(r.b_prof_email, r.b_email)   ELSE r.b_email END  AS b_email,
      CASE WHEN r.b_merged THEN coalesce(r.b_prof_phone, r.b_phone)   ELSE r.b_phone END  AS b_phone,
      CASE WHEN r.b_merged THEN coalesce(r.b_prof_billing_business_name, r.b_billing_business_name) ELSE r.b_billing_business_name END AS b_billing_business_name,
      CASE WHEN r.b_merged THEN coalesce(r.b_prof_billing_address,       r.b_billing_address)       ELSE r.b_billing_address END       AS b_billing_address,
      CASE WHEN r.b_merged THEN coalesce(r.b_prof_billing_btw_number,    r.b_billing_btw_number)    ELSE r.b_billing_btw_number END    AS b_billing_btw_number,
      CASE WHEN r.b_merged THEN coalesce(r.b_prof_skill_rating, r.b_skill_rating) ELSE r.b_skill_rating END AS b_skill_rating,
      CASE WHEN r.b_merged THEN coalesce(r.b_prof_rating_system, r.b_rating_system) ELSE r.b_rating_system END AS b_rating_system,
      r.b_notes,
      r.b_source,
      CASE WHEN r.b_merged THEN coalesce(r.b_prof_birth_date, r.b_birth_date) ELSE r.b_birth_date END AS b_birth_date,
      r.b_has_trained,
      r.b_created_at,
      r.b_owner_trainer_id,
      r.b_owner_trainer_ids,
      r.b_search_sides,
      r.b_all_emails
    FROM rolled r
    LEFT JOIN public.persons pe ON r.b_merged AND pe.id = r.b_person_id
  ),
  -- metadata: ONE guest-side-first row per person supplies id + tags + notes TOGETHER.
  -- Read and write must target the same row — a union/other-row fallback here made tags and
  -- notes edited via metadata_id unremovable (the displayed value survived on a row the
  -- client never writes). A merged person's profile-side metadata row is dormant until the
  -- membership layer (3.5) unifies metadata person-wide.
  with_meta AS (
    SELECT b.*,
           md.id AS b_metadata_id,
           coalesce(md.tag_ids, '{}'::uuid[]) AS b_tag_ids,
           md.notes AS b_academy_notes
    FROM base b
    LEFT JOIN LATERAL (
      SELECT m.id, m.tag_ids, m.notes
      FROM public.academy_player_metadata m
      WHERE ((p_scope = 'academy' AND m.academy_profile_id  = p_scope_id)
          OR (p_scope = 'trainer' AND m.trainer_profile_id = p_scope_id))
        AND (m.guest_player_id = ANY (b.b_guest_ids)
          OR (b.b_profile_id IS NOT NULL AND m.profile_id = b.b_profile_id))
      ORDER BY (m.guest_player_id IS NULL), m.created_at, m.id
      LIMIT 1
    ) md ON true
  ),
  -- PTF-OPTION-A: the persons (and clubs) with a qualifying session, matched ONCE at set level with
  -- the same REF-SET rule as every booking predicate below (a guest ref, or a pure-profile booking).
  -- The two filters then test membership with an uncorrelated IN (a hashed lookup), instead of
  -- re-scanning training_now for every row. Empty unless a training key is set (training_now is).
  training_persons AS (
    SELECT w.b_person_id AS tp_person_id, t.t_location_id AS tp_location_id
      FROM with_meta w
      CROSS JOIN LATERAL unnest(w.b_guest_ids) AS g(id)
      JOIN training_now t ON t.t_guest_id = g.id
    UNION
    SELECT w.b_person_id, t.t_location_id
      FROM with_meta w
      JOIN training_now t ON t.t_player_id = w.b_profile_id AND t.t_guest_id IS NULL
     WHERE w.b_profile_id IS NOT NULL
  ),
  filtered AS (
    SELECT w.*
    FROM with_meta w
    WHERE
      -- search: every token must match folded name/email/business/phone text,
      -- or (>= 3 digits) the digits-normalized phone. b_search_sides keeps EVERY side
      -- identity searchable — a trainer who only knows the roster-side (guest) name or email
      -- must still find the merged human even though the row displays the profile identity.
      (v_tokens IS NULL OR NOT EXISTS (
        SELECT 1 FROM unnest(v_tokens) tok
        WHERE tok <> ''
          AND NOT (
            public.fold_search_text(
              w.b_full_name || ' ' || w.b_email || ' '
              || coalesce(w.b_billing_business_name, '') || ' ' || w.b_phone
              || ' ' || coalesce(w.b_search_sides, '')
            ) LIKE '%' || tok || '%'
            OR (length(public.digits_only(tok)) >= 3
                AND public.digits_only(w.b_phone || ' ' || coalesce(w.b_search_sides, ''))
                    LIKE '%' || public.digits_only(tok) || '%')
          )
      ))
      -- level band: half-open (level_gt, level_max], or unrated
      AND (
        (v_level_gt IS NULL AND v_level_max IS NULL AND NOT v_level_unrated)
        OR (v_level_unrated AND w.b_skill_rating IS NULL)
        OR (NOT v_level_unrated AND w.b_skill_rating IS NOT NULL
            AND (v_level_gt IS NULL OR w.b_skill_rating > v_level_gt)
            AND (v_level_max IS NULL OR w.b_skill_rating <= v_level_max))
      )
      -- tag
      AND (v_tag IS NULL
        OR (v_tag = 'untagged' AND coalesce(array_length(w.b_tag_ids, 1), 0) = 0)
        OR (v_tag <> 'untagged' AND w.b_tag_ids @> ARRAY[v_tag::uuid]))
      -- trainer (owner trainer OR any in-scope booking with that trainer).
      -- REF-SET match (here and in every booking/intake predicate below): the row counts for
      -- this person iff its guest is one of the person's non-frozen in-scope refs, or it is a
      -- PURE-PROFILE row of the person's profile — FAM-02: a dual-keyed row is the GUEST
      -- person's activity (mirrors the 3.1 r3 pure-profile player policies).
      AND (v_filter_trainer IS NULL
        OR v_filter_trainer = ANY (w.b_owner_trainer_ids)
        OR EXISTS (
          SELECT 1 FROM public.bookings b JOIN scope_slots ss ON ss.id = b.slot_id
          WHERE ss.trainer_id = v_filter_trainer
            AND b.status IN ('confirmed','completed')
            AND (b.guest_player_id = ANY (w.b_guest_ids)
              OR (w.b_profile_id IS NOT NULL AND b.player_id = w.b_profile_id
                  AND b.guest_player_id IS NULL))))
      -- location: trained (active academy loc) OR preferred OR enrolled-intake, merged
      -- locations resolved to canonical — an EXACT mirror of the displayed array below,
      -- so filtering by a club returns precisely the players whose chip shows it.
      AND (v_filter_location IS NULL OR (
        EXISTS (
          SELECT 1
          FROM (
            SELECT ss.location_id AS loc, true AS requires_active
              FROM public.bookings b JOIN scope_slots ss ON ss.id = b.slot_id
             WHERE b.status IN ('confirmed','completed')
               AND ss.location_id IS NOT NULL
               AND (b.guest_player_id = ANY (w.b_guest_ids)
                 OR (w.b_profile_id IS NOT NULL AND b.player_id = w.b_profile_id
                     AND b.guest_player_id IS NULL))
            UNION ALL
            SELECT g.preferred_location_id, false
              FROM public.guest_players g
             WHERE g.id = ANY (w.b_guest_ids) AND g.preferred_location_id IS NOT NULL
            UNION ALL
            SELECT m.preferred_location_id, false
              FROM public.academy_player_metadata m
             WHERE ((p_scope = 'academy' AND m.academy_profile_id  = p_scope_id)
                 OR (p_scope = 'trainer' AND m.trainer_profile_id = p_scope_id))
               AND m.preferred_location_id IS NOT NULL
               AND (m.guest_player_id = ANY (w.b_guest_ids)
                 OR (w.b_profile_id IS NOT NULL AND m.profile_id = w.b_profile_id))
            UNION ALL
            SELECT ir.location_id, false
              FROM public.intake_requests ir
             WHERE ir.location_id IS NOT NULL
               AND (ir.guest_player_id = ANY (w.b_guest_ids)
                 OR (w.b_profile_id IS NOT NULL AND ir.player_id = w.b_profile_id
                     AND ir.guest_player_id IS NULL))
            UNION ALL
            SELECT apl.location_id, false
              FROM public.academy_player_locations apl
             WHERE p_scope = 'academy' AND apl.academy_profile_id = p_scope_id AND apl.dismissed = false
               AND (apl.guest_player_id = ANY (w.b_guest_ids)
                 OR (w.b_profile_id IS NOT NULL AND apl.profile_id = w.b_profile_id))
          ) src
          LEFT JOIN public.locations lm ON lm.id = src.loc
          WHERE coalesce(lm.merged_into, src.loc) = v_filter_location
            AND (p_scope = 'trainer'
              OR EXISTS (SELECT 1 FROM public.academy_locations al
                         WHERE al.academy_profile_id = p_scope_id
                           AND al.location_id = coalesce(lm.merged_into, src.loc)
                           AND (al.is_active OR NOT src.requires_active)))
        )
        AND NOT (p_scope = 'academy' AND EXISTS (
          SELECT 1 FROM public.academy_player_locations apl
          LEFT JOIN public.locations lm2 ON lm2.id = apl.location_id
          WHERE apl.academy_profile_id = p_scope_id AND apl.dismissed = true
            AND coalesce(lm2.merged_into, apl.location_id) = v_filter_location
            AND (apl.guest_player_id = ANY (w.b_guest_ids)
              OR (w.b_profile_id IS NOT NULL AND apl.profile_id = w.b_profile_id))))
      ))
      -- active cyclus
      AND (v_has_cyclus IS NULL OR v_has_cyclus = EXISTS (
          SELECT 1 FROM public.bookings b JOIN scope_slots ss ON ss.id = b.slot_id
          WHERE ss.cyclus_id IS NOT NULL AND ss.end_time >= now()
            AND b.status IN ('confirmed','completed')
            AND (b.guest_player_id = ANY (w.b_guest_ids)
              OR (w.b_profile_id IS NOT NULL AND b.player_id = w.b_profile_id
                  AND b.guest_player_id IS NULL))))
      -- PTF-OPTION-A current training / training club: both read training_persons, i.e. the one
      -- training_now predicate matched by person. has_active_cyclus and the location chip filter
      -- above keep their existing, different meanings.
      AND (v_current_training IS NULL OR v_current_training = (
          w.b_person_id IN (SELECT tp.tp_person_id FROM training_persons tp)))
      AND (v_training_location IS NULL OR
          w.b_person_id IN (SELECT tp.tp_person_id FROM training_persons tp
                             WHERE tp.tp_location_id = v_training_location))
      -- payment status (parity with fetchOverduePayments). ADDRESSEE EXEMPTION: player_id-
      -- addressed invoices match WITHOUT the pure-profile guard — an invoice addressed to a
      -- profile is that person's to pay even when the seat it bills is a guest's (3.1 r3).
      AND (v_payment IS NULL OR (v_payment = 'overdue') = EXISTS (
          SELECT 1 FROM public.invoices i
          WHERE ((p_scope = 'academy' AND i.academy_profile_id = p_scope_id)
              OR (p_scope = 'trainer' AND i.trainer_id         = p_scope_id))
            AND (i.guest_player_id = ANY (w.b_guest_ids)
              OR (w.b_profile_id IS NOT NULL AND i.player_id = w.b_profile_id))
            AND (lower(i.status) = 'overdue'
              OR (i.due_date < current_date
                  AND i.paid_at IS NULL
                  AND lower(i.status) NOT IN ('paid','cancelled','draft','void')))))
  ),
  -- The ONE sort definition: every row's 1-based position in list order. The window is read by
  -- ordinal, so a list page and the export can never order differently.
  numbered AS (
    SELECT f.*,
           count(*) OVER ()         AS b_total_count,
           row_number() OVER w_sort AS b_ord
    FROM filtered f
    WINDOW w_sort AS (ORDER BY
      CASE WHEN p_sort = 'name'       AND p_sort_dir = 'asc'  THEN lower(f.b_full_name) END ASC,
      CASE WHEN p_sort = 'name'       AND p_sort_dir = 'desc' THEN lower(f.b_full_name) END DESC,
      CASE WHEN p_sort = 'email'      AND p_sort_dir = 'asc'  THEN nullif(lower(f.b_email), '') END ASC NULLS LAST,
      CASE WHEN p_sort = 'email'      AND p_sort_dir = 'desc' THEN nullif(lower(f.b_email), '') END DESC NULLS LAST,
      CASE WHEN p_sort = 'skill'      AND p_sort_dir = 'asc'  THEN f.b_skill_rating END ASC NULLS LAST,
      CASE WHEN p_sort = 'skill'      AND p_sort_dir = 'desc' THEN f.b_skill_rating END DESC NULLS LAST,
      CASE WHEN p_sort = 'created_at' AND p_sort_dir = 'asc'  THEN f.b_created_at END ASC,
      CASE WHEN p_sort = 'created_at' AND p_sort_dir = 'desc' THEN f.b_created_at END DESC,
      lower(f.b_full_name) ASC,
      f.b_player_key ASC)
  ),
  page AS (
    SELECT n.*
    FROM numbered n
    WHERE n.b_ord > p_offset AND n.b_ord <= p_offset::bigint + p_limit
  )
  -- Expensive aggregates only for the window rows, and only when asked (the export does not read them;
  -- without p_enrich they keep their defaults).
  SELECT
    c.b_player_key, c.b_player_type, c.b_guest_player_id, c.b_profile_id, c.b_person_id,
    c.b_full_name, c.b_email, c.b_phone,
    c.b_billing_business_name, c.b_billing_address, c.b_billing_btw_number,
    c.b_skill_rating, c.b_rating_system, c.b_notes, c.b_source, c.b_birth_date,
    c.b_has_trained, c.b_created_at, c.b_owner_trainer_id,
    c.b_metadata_id, c.b_tag_ids, c.b_academy_notes,
    coalesce(enr.trainer_ids, c.b_owner_trainer_ids),
    coalesce(enr.location_ids, '{}'::uuid[]),
    coalesce(enr.location_names, '{}'::text[]),
    coalesce(enr.has_active_cyclus, false),
    coalesce(pay.has_overdue_payment, false),
    coalesce(eb.email_undeliverable, false),
    c.b_total_count,
    c.b_ord
  FROM page c
  LEFT JOIN LATERAL (
    WITH pb AS (
      SELECT ss.trainer_id, ss.location_id, ss.cyclus_id, ss.end_time
      FROM public.bookings b JOIN scope_slots ss ON ss.id = b.slot_id
      WHERE b.status IN ('confirmed','completed')
        AND (b.guest_player_id = ANY (c.b_guest_ids)
          OR (c.b_profile_id IS NOT NULL AND b.player_id = c.b_profile_id
              AND b.guest_player_id IS NULL))
    )
    SELECT
      (SELECT coalesce(array_agg(DISTINCT t.tid), '{}'::uuid[])
         FROM (SELECT pb.trainer_id AS tid FROM pb WHERE pb.trainer_id IS NOT NULL
               UNION
               SELECT unnest(c.b_owner_trainer_ids)) t)
        AS trainer_ids,
      loc.location_ids,
      loc.location_names,
      EXISTS (SELECT 1 FROM pb WHERE pb.cyclus_id IS NOT NULL AND pb.end_time >= now())
        AS has_active_cyclus
    FROM (
      SELECT coalesce(array_agg(l.id   ORDER BY l.name), '{}'::uuid[]) AS location_ids,
             coalesce(array_agg(l.name ORDER BY l.name), '{}'::text[]) AS location_names
      FROM (
        -- canonical loc id + whether EVERY source for it requires an active academy
        -- location (only-trained => true; any preferred/intake source => false)
        SELECT coalesce(lm.merged_into, cand.location_id) AS location_id,
               bool_and(cand.requires_active) AS req_active
        FROM (
          SELECT pb.location_id, true AS requires_active
            FROM pb WHERE pb.location_id IS NOT NULL
          UNION ALL
          SELECT pref.pl, false
            FROM (
              SELECT g.preferred_location_id AS pl
                FROM public.guest_players g WHERE g.id = ANY (c.b_guest_ids)
              UNION ALL
              SELECT m.preferred_location_id
                FROM public.academy_player_metadata m
               WHERE ((p_scope = 'academy' AND m.academy_profile_id  = p_scope_id)
                   OR (p_scope = 'trainer' AND m.trainer_profile_id = p_scope_id))
                 AND (m.guest_player_id = ANY (c.b_guest_ids)
                   OR (c.b_profile_id IS NOT NULL AND m.profile_id = c.b_profile_id))
            ) pref WHERE pref.pl IS NOT NULL
          UNION ALL
          SELECT ir.location_id, false
            FROM public.intake_requests ir
           WHERE ir.location_id IS NOT NULL
             AND (ir.guest_player_id = ANY (c.b_guest_ids)
               OR (c.b_profile_id IS NOT NULL AND ir.player_id = c.b_profile_id
                   AND ir.guest_player_id IS NULL))
          UNION ALL
          SELECT apl.location_id, false
            FROM public.academy_player_locations apl
           WHERE p_scope = 'academy' AND apl.academy_profile_id = p_scope_id AND apl.dismissed = false
             AND (apl.guest_player_id = ANY (c.b_guest_ids)
               OR (c.b_profile_id IS NOT NULL AND apl.profile_id = c.b_profile_id))
        ) cand
        LEFT JOIN public.locations lm ON lm.id = cand.location_id
        GROUP BY coalesce(lm.merged_into, cand.location_id)
      ) d
      JOIN public.locations l ON l.id = d.location_id
      WHERE (p_scope = 'trainer'
         OR EXISTS (SELECT 1 FROM public.academy_locations al
                    WHERE al.academy_profile_id = p_scope_id
                      AND al.location_id = d.location_id
                      AND (al.is_active OR NOT d.req_active)))
        AND NOT (p_scope = 'academy' AND EXISTS (
              SELECT 1 FROM public.academy_player_locations apl
              LEFT JOIN public.locations lm2 ON lm2.id = apl.location_id
              WHERE apl.academy_profile_id = p_scope_id AND apl.dismissed = true
                AND coalesce(lm2.merged_into, apl.location_id) = d.location_id
                AND (apl.guest_player_id = ANY (c.b_guest_ids)
                  OR (c.b_profile_id IS NOT NULL AND apl.profile_id = c.b_profile_id))))
    ) loc
    WHERE p_enrich
  ) enr ON true
  LEFT JOIN LATERAL (
    SELECT EXISTS (
      SELECT 1 FROM public.invoices i
      WHERE ((p_scope = 'academy' AND i.academy_profile_id = p_scope_id)
          OR (p_scope = 'trainer' AND i.trainer_id         = p_scope_id))
        AND (i.guest_player_id = ANY (c.b_guest_ids)
          OR (c.b_profile_id IS NOT NULL AND i.player_id = c.b_profile_id))
        AND (lower(i.status) = 'overdue'
          OR (i.due_date < current_date
              AND i.paid_at IS NULL
              AND lower(i.status) NOT IN ('paid','cancelled','draft','void')))
    ) AS has_overdue_payment
    WHERE p_enrich
  ) pay ON true
  LEFT JOIN LATERAL (
    -- deliverability across EVERY side email: invoices to a merged person's guest seat keep
    -- going to the guest-side address, so a bounce there must still badge the (profile-
    -- identity) row. Unmerged rows have exactly one side email — behavior unchanged.
    SELECT EXISTS (
      SELECT 1 FROM public.email_address_state s
      WHERE (s.email = lower(btrim(c.b_email)) OR s.email = ANY (c.b_all_emails))
        AND s.is_suppressed
    ) AS email_undeliverable
    WHERE p_enrich
  ) eb ON true
  ORDER BY c.b_ord;
END;
$$;
REVOKE ALL ON FUNCTION players_private.players_overview_rows(text, uuid, text, jsonb, text, text, integer, integer, boolean) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_players_overview(
  p_scope text,                       -- 'academy' | 'trainer'
  p_scope_id uuid,
  p_search text DEFAULT NULL,
  p_filters jsonb DEFAULT '{}'::jsonb,
  p_sort text DEFAULT 'name',         -- 'name' | 'email' | 'skill' | 'created_at'
  p_sort_dir text DEFAULT 'asc',
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  player_key text,
  player_type text,
  guest_player_id uuid,
  profile_id uuid,
  person_id uuid,
  full_name text,
  email text,
  phone text,
  billing_business_name text,
  billing_address text,
  billing_btw_number text,
  skill_rating numeric,
  rating_system text,
  notes text,
  source text,
  birth_date date,
  has_trained boolean,
  created_at timestamptz,
  owner_trainer_id uuid,
  metadata_id uuid,
  tag_ids uuid[],
  academy_notes text,
  trainer_ids uuid[],
  location_ids uuid[],
  location_names text[],
  has_active_cyclus boolean,
  has_overdue_payment boolean,
  email_undeliverable boolean,
  total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- ---- authorization at this public entry (the authority re-checks it) ----
  IF p_scope = 'academy' THEN
    IF NOT public.is_academy_manager(auth.uid(), p_scope_id) THEN
      RAISE EXCEPTION 'not authorized for academy %', p_scope_id USING ERRCODE = '42501';
    END IF;
  ELSIF p_scope = 'trainer' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.trainer_profiles tp
       WHERE tp.id = p_scope_id AND tp.user_id = auth.uid()
    ) THEN
      RAISE EXCEPTION 'not authorized for trainer %', p_scope_id USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid scope: %', p_scope;
  END IF;

  -- One page (at most 500 rows) in list order, with the page-only enrichment.
  RETURN QUERY
  SELECT r.player_key, r.player_type, r.guest_player_id, r.profile_id, r.person_id,
         r.full_name, r.email, r.phone,
         r.billing_business_name, r.billing_address, r.billing_btw_number,
         r.skill_rating, r.rating_system, r.notes, r.source, r.birth_date,
         r.has_trained, r.created_at, r.owner_trainer_id,
         r.metadata_id, r.tag_ids, r.academy_notes,
         r.trainer_ids, r.location_ids, r.location_names,
         r.has_active_cyclus, r.has_overdue_payment, r.email_undeliverable,
         r.total_count
    FROM players_private.players_overview_rows(
           p_scope, p_scope_id, p_search, p_filters, p_sort, p_sort_dir,
           least(greatest(coalesce(p_limit, 50), 1), 500),
           greatest(coalesce(p_offset, 0), 0),
           true) r
   ORDER BY r.sort_ord;
END;
$$;
REVOKE ALL ON FUNCTION public.get_players_overview(text, uuid, text, jsonb, text, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_players_overview(text, uuid, text, jsonb, text, text, integer, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_players_overview_export(
  p_academy uuid,
  p_search text DEFAULT NULL,
  p_filters jsonb DEFAULT '{}'::jsonb,
  p_sort text DEFAULT 'name',         -- as get_players_overview
  p_sort_dir text DEFAULT 'asc'
)
RETURNS TABLE (
  total bigint,
  rows jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  c_max CONSTANT integer := 20000;
  v_total bigint;
  v_rows jsonb;
BEGIN
  -- ---- authorization at this public entry (the authority re-checks it) ----
  IF NOT public.is_academy_manager(auth.uid(), p_academy) THEN
    RAISE EXCEPTION 'not authorized for academy %', p_academy USING ERRCODE = '42501';
  END IF;

  -- ONE statement, ONE evaluation of the authority: the total and the rows come from the same rows.
  -- total_count is the window count of EVERY match (taken before the window), so at most c_max rows are
  -- materialized and an oversized request costs no more than a full export.
  SELECT coalesce(max(r.total_count), 0),
         coalesce(jsonb_agg(jsonb_build_object(
                    'person_id', r.person_id,
                    'full_name', r.full_name,
                    'email',     r.email,
                    'phone',     r.phone)
                  ORDER BY r.sort_ord), '[]'::jsonb)
    INTO v_total, v_rows
    FROM players_private.players_overview_rows(
           'academy', p_academy, p_search, p_filters, p_sort, p_sort_dir, c_max, 0, false) r;

  IF v_total > c_max THEN
    RAISE EXCEPTION 'player export too large: % players match, at most % can be exported', v_total, c_max
      USING ERRCODE = '54000', DETAIL = format('total=%s max=%s', v_total, c_max);
  END IF;

  RETURN QUERY SELECT v_total, v_rows;
END;
$$;
REVOKE ALL ON FUNCTION public.get_players_overview_export(uuid, text, jsonb, text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_players_overview_export(uuid, text, jsonb, text, text) TO authenticated;
