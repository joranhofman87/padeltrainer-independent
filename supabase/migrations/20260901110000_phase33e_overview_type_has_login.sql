-- ============================================================================
-- Phase 3.3e (person-unification): the players-overview TYPE column tells LOGINS
-- ============================================================================
-- Owner-reported after the 3.3 deploy: 6 RL Padel players with an account showed
-- 'Guest' in the players-list Type column. get_players_overview computed
-- player_type from b_has_login = bool_or(profile side IN SCOPE) — so a login
-- holder who only ever attended as a GUEST (no in-scope player_id booking → no
-- profile side in `sided`) was labelled 'guest'. This is the SAME seat-vs-login
-- bug already fixed on the cycle-roster badge (3.3a) and the detail page (3.3d).
--
-- player_type now = 'registered' iff the resolved PERSON has a login
-- (persons.user_id of b_person_id). A split-frozen clicked guest keys as its own
-- accountless person → 'guest'. Everything else re-emitted VERBATIM from
-- 20260827100000. Signature unchanged → CREATE OR REPLACE, no types-drift. No
-- client change: the list already renders off player_type; a 'registered' row
-- may now carry profile_id NULL (profile out of scope) — the Type/Status badges
-- only read player_type, and detail links / edit flows key on
-- guest_player_id/profile_id independently, so nothing downstream breaks.
-- ============================================================================

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
SET search_path = public
AS $$
DECLARE
  v_trainer_ids uuid[];
  v_tokens text[];
  v_filter_trainer uuid    := nullif(p_filters->>'trainer_id','')::uuid;
  v_filter_location uuid   := nullif(p_filters->>'location_id','')::uuid;
  v_level_gt numeric       := (p_filters->>'level_gt')::numeric;   -- exclusive lower bound
  v_level_max numeric      := (p_filters->>'level_max')::numeric;  -- inclusive upper bound
  v_level_unrated boolean  := coalesce((p_filters->>'level_unrated')::boolean, false);
  v_has_cyclus boolean     := (p_filters->>'has_active_cyclus')::boolean;  -- NULL = no filter
  v_tag text               := nullif(p_filters->>'tag_id','');             -- uuid text | 'untagged'
  v_payment text           := nullif(p_filters->>'payment','');            -- 'overdue' | 'ok'
  v_limit integer          := least(greatest(coalesce(p_limit, 50), 1), 500);
  v_offset integer         := greatest(coalesce(p_offset, 0), 0);
BEGIN
  -- ---- authorization (explicit; the function bypasses RLS below) ----
  IF p_scope = 'academy' THEN
    IF NOT public.is_academy_manager(auth.uid(), p_scope_id) THEN
      RAISE EXCEPTION 'not authorized for academy %', p_scope_id USING ERRCODE = '42501';
    END IF;
    SELECT coalesce(array_agg(at.trainer_profile_id), '{}'::uuid[])
      INTO v_trainer_ids
      FROM public.academy_trainers at
     WHERE at.academy_profile_id = p_scope_id AND at.status = 'active';
  ELSIF p_scope = 'trainer' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.trainer_profiles tp
       WHERE tp.id = p_scope_id AND tp.user_id = auth.uid()
    ) THEN
      RAISE EXCEPTION 'not authorized for trainer %', p_scope_id USING ERRCODE = '42501';
    END IF;
    v_trainer_ids := ARRAY[p_scope_id];
  ELSE
    RAISE EXCEPTION 'invalid scope: %', p_scope;
  END IF;

  IF coalesce(btrim(p_search), '') <> '' THEN
    v_tokens := regexp_split_to_array(public.fold_search_text(btrim(p_search)), '\s+');
  END IF;

  RETURN QUERY
  WITH scope_slots AS (
    SELECT s.id, s.trainer_id, s.location_id, s.cyclus_id, s.end_time
    FROM public.availability_slots s
    WHERE s.trainer_id = ANY (v_trainer_ids)
  ),
  removed_meta AS (
    SELECT m.guest_player_id AS gid, m.profile_id AS pid
    FROM public.academy_player_metadata m
    WHERE m.removed_at IS NOT NULL
      AND ((p_scope = 'academy' AND m.academy_profile_id  = p_scope_id)
        OR (p_scope = 'trainer' AND m.trainer_profile_id = p_scope_id))
  ),
  guests AS (
    SELECT g.*
    FROM public.guest_players g
    WHERE ((p_scope = 'academy'
            AND (g.academy_profile_id = p_scope_id OR g.trainer_id = ANY (v_trainer_ids)))
        OR (p_scope = 'trainer' AND g.trainer_id = p_scope_id))
      AND NOT EXISTS (SELECT 1 FROM removed_meta rm WHERE rm.gid = g.id)
  ),
  -- DELIBERATELY UNCHANGED membership predicate: any in-scope booking with player_id set
  -- (dual-keyed included) — see the header. Only the DEDUP below is new in this phase.
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
  page AS (
    SELECT f.*, count(*) OVER () AS b_total_count
    FROM filtered f
    ORDER BY
      CASE WHEN p_sort = 'name'       AND p_sort_dir = 'asc'  THEN lower(f.b_full_name) END ASC,
      CASE WHEN p_sort = 'name'       AND p_sort_dir = 'desc' THEN lower(f.b_full_name) END DESC,
      CASE WHEN p_sort = 'email'      AND p_sort_dir = 'asc'  THEN nullif(lower(f.b_email), '') END ASC NULLS LAST,
      CASE WHEN p_sort = 'email'      AND p_sort_dir = 'desc' THEN nullif(lower(f.b_email), '') END DESC NULLS LAST,
      CASE WHEN p_sort = 'skill'      AND p_sort_dir = 'asc'  THEN f.b_skill_rating END ASC NULLS LAST,
      CASE WHEN p_sort = 'skill'      AND p_sort_dir = 'desc' THEN f.b_skill_rating END DESC NULLS LAST,
      CASE WHEN p_sort = 'created_at' AND p_sort_dir = 'asc'  THEN f.b_created_at END ASC,
      CASE WHEN p_sort = 'created_at' AND p_sort_dir = 'desc' THEN f.b_created_at END DESC,
      lower(f.b_full_name) ASC,
      f.b_player_key ASC
    LIMIT v_limit OFFSET v_offset
  )
  -- Expensive aggregates only for the page rows (bounded by v_limit).
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
    c.b_total_count
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
  ) pay ON true
  LEFT JOIN LATERAL (
    -- deliverability across EVERY side email: invoices to a merged person's guest seat keep
    -- going to the guest-side address, so a bounce there must still badge the (profile-
    -- identity) row. Unmerged rows have exactly one side email — behavior unchanged.
    SELECT EXISTS (
      SELECT 1 FROM public.email_address_state s
      WHERE (s.email = lower(btrim(c.b_email)) OR s.email = ANY (c.b_all_emails))
        AND s.state IN ('hard_bounced','complained')
    ) AS email_undeliverable
  ) eb ON true;
END;
$$;

REVOKE ALL ON FUNCTION public.get_players_overview(text, uuid, text, jsonb, text, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_players_overview(text, uuid, text, jsonb, text, text, integer, integer) TO authenticated;
