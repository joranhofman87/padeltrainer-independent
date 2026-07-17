-- ============================================================================
-- Phase 3.2 (person-unification): the PLAYERS OVERVIEW + CYCLUS GROUPS list
-- render PERSONS, not old-world rows (plan §5 cluster 1, second half)
-- ============================================================================
-- What the owner sees today: a merged human (profile + guest twin linked to ONE
-- person via person_links) appears TWICE on the academy/trainer Players page and
-- can be double-counted in the cyclus-groups roster names. Phase 3.1 already
-- person-keyed the cycle-detail roster; this migration does the remaining two
-- list surfaces.
--
--   1. `is_guest_split_frozen(uuid)` — the split-pending freeze as a NAMED
--      choke point. Both RPCs below must ignore a guest's person link while a
--      `twin_detached_needs_split` / `merged_guest_email_moved` review is
--      pending (the link may describe a DIFFERENT human). Phase 3.1 inlined
--      this EXISTS in every reader arm; two more multi-arm readers is where
--      copy-paste drift starts, so the rule gets a name. SECURITY DEFINER per
--      the 0c doctrine (person_merge_review is RLS-locked; a non-definer helper
--      silently returns false under caller RLS). Client-REVOKEd.
--
--   2. `get_players_overview` — ONE ROW PER PERSON:
--      • in-scope guest rows and registered profiles resolve to their person
--        (frozen guests + unlinked rows key as themselves — congruent with
--        deterministic person ids, so unstamped/unlinked data degrades to
--        today's split, never worse);
--      • a merged person's row carries BOTH keys (guest_player_id = the
--        guest-preferred primary ref, profile_id, plus ALL in-scope guest refs
--        internally for activity matching) and `player_type = 'registered'`
--        (the person has a login);
--      • `player_key` stays old-world-parseable ('g_…' preferred, else 'p_…')
--        because invoiceCustomer + the player-detail routes parse it; the NEW
--        `person_id` column is the person-unification key;
--      • merged rows take their identity fields from PERSONS — the rederive
--        choke point already implements profile-first precedence + the freeze;
--        re-deriving per-field precedence here is exactly the call-site
--        duplication three audits punished. Single-side rows keep today's
--        expressions verbatim (zero churn for unmerged people);
--      • metadata joins person-wide: tag_ids = the UNION across the person's
--        in-scope metadata rows, metadata_id/academy_notes = guest-side-first
--        pick (edits keep landing on the roster-managed guest row);
--      • activity matching (trainer/location/cyclus filters + chips) is
--        REF-SET based: a booking/intake row counts for the person iff its
--        guest belongs to the person's non-frozen in-scope refs, or it is a
--        PURE-PROFILE row of the person's profile (guest_player_id IS NULL —
--        FAM-02, same rule the 3.1 round-3 hardening put on the player RLS
--        policies: a dual-keyed row is the GUEST person's activity, so an
--        UNMERGED parent no longer wears their child's activity chips);
--      • EXCEPTION kept on purpose: invoice matching (overdue badge/filter)
--        still matches player_id-addressed invoices WITHOUT the pure-profile
--        guard — invoices addressed to a profile are legitimately that
--        person's to pay (the same addressee exemption 3.1 r3 left in
--        playerBookings' invoices fallback);
--      • DELIBERATELY UNCHANGED: list MEMBERSHIP. `registered` still means
--        "any in-scope booking with player_id set" (dual-keyed included), so
--        no parent vanishes from the list in this phase; whether dual-keyed
--        seats should confer membership at all is a 3.3/3.5 question.
--
--   3. `get_academy_cyclus_groups` — roster names keyed by PERSON uuid
--      (guest-first on dual-keyed rows per FAM-02, frozen guests as
--      themselves, unlinked rows as their source uuid). A merged human booked
--      via both their guest seat and their own profile in one group is ONE
--      name; their display name is the persons row's (same source the cycle
--      detail shows). Return columns UNCHANGED; everything else re-emitted
--      verbatim from 20260820100000.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) the split-pending freeze, as a named predicate
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_guest_split_frozen(_guest_player_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT _guest_player_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.person_merge_review r
    WHERE r.guest_player_id = _guest_player_id
      AND r.status = 'pending'
      AND r.kind IN ('twin_detached_needs_split', 'merged_guest_email_moved')
  );
$$;

COMMENT ON FUNCTION public.is_guest_split_frozen(uuid) IS
  'Split-pending freeze (person-unification): while a twin_detached_needs_split / merged_guest_email_moved review is pending, the guest''s person link may describe a DIFFERENT human — readers must treat the guest as its OWN person and rederive_person excludes it from aggregation. SECURITY DEFINER because person_merge_review is RLS-locked. Definer-internal helper: not client-callable.';

REVOKE ALL ON FUNCTION public.is_guest_split_frozen(uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2) get_players_overview — one row per person
-- ---------------------------------------------------------------------------
-- The RETURNS TABLE changes (adds person_id), so CREATE OR REPLACE would fail.
DROP FUNCTION IF EXISTS public.get_players_overview(text, uuid, text, jsonb, text, text, integer, integer);

CREATE FUNCTION public.get_players_overview(
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
  -- PERSON rollup: one row per person. Side-field picks are guest-first (for a single-side
  -- person this IS that side's value, so unmerged rows render exactly as before).
  rolled AS (
    SELECT
      s.s_person_id                                               AS b_person_id,
      (count(*) > 1)                                              AS b_merged,
      bool_or(s.s_profile_id IS NOT NULL)                         AS b_has_login,
      (array_agg(s.s_guest_player_id ORDER BY s.s_created_at)
         FILTER (WHERE s.s_guest_player_id IS NOT NULL))[1]       AS b_guest_player_id,
      array_remove(array_agg(s.s_guest_player_id), NULL)          AS b_guest_ids,
      -- at most one profile per person (one-profile-per-person index); no max(uuid) in PG
      (array_remove(array_agg(s.s_profile_id), NULL))[1]          AS b_profile_id,
      (array_agg(s.s_full_name  ORDER BY (s.s_guest_player_id IS NULL), s.s_created_at))[1] AS b_full_name,
      coalesce((array_remove(array_agg(nullif(s.s_email, '')  ORDER BY (s.s_guest_player_id IS NULL), s.s_created_at), NULL))[1], '') AS b_email,
      coalesce((array_remove(array_agg(nullif(s.s_phone, '')  ORDER BY (s.s_guest_player_id IS NULL), s.s_created_at), NULL))[1], '') AS b_phone,
      (array_remove(array_agg(s.s_billing_business_name ORDER BY (s.s_guest_player_id IS NULL), s.s_created_at), NULL))[1] AS b_billing_business_name,
      (array_remove(array_agg(s.s_billing_address       ORDER BY (s.s_guest_player_id IS NULL), s.s_created_at), NULL))[1] AS b_billing_address,
      (array_remove(array_agg(s.s_billing_btw_number    ORDER BY (s.s_guest_player_id IS NULL), s.s_created_at), NULL))[1] AS b_billing_btw_number,
      (array_remove(array_agg(s.s_skill_rating          ORDER BY (s.s_guest_player_id IS NULL), s.s_created_at), NULL))[1] AS b_skill_rating,
      (array_agg(s.s_rating_system ORDER BY (s.s_guest_player_id IS NULL), s.s_created_at))[1] AS b_rating_system,
      (array_remove(array_agg(s.s_notes  ORDER BY (s.s_guest_player_id IS NULL), s.s_created_at), NULL))[1] AS b_notes,
      (array_remove(array_agg(s.s_source ORDER BY (s.s_guest_player_id IS NULL), s.s_created_at), NULL))[1] AS b_source,
      (array_remove(array_agg(s.s_birth_date ORDER BY (s.s_guest_player_id IS NULL), s.s_created_at), NULL))[1] AS b_birth_date,
      bool_or(s.s_has_trained)                                    AS b_has_trained,
      min(s.s_created_at)                                         AS b_created_at,
      (array_remove(array_agg(s.s_owner_trainer_id ORDER BY (s.s_guest_player_id IS NULL), s.s_created_at), NULL))[1] AS b_owner_trainer_id
    FROM sided s
    GROUP BY s.s_person_id
  ),
  -- merged rows take their IDENTITY from persons — the rederive choke point (profile-first
  -- precedence + the freeze already applied there). Rollup values remain the fallback so a
  -- blank persons field never blanks the row.
  base AS (
    SELECT
      r.b_person_id,
      CASE WHEN r.b_guest_player_id IS NOT NULL
           THEN 'g_' || r.b_guest_player_id::text
           ELSE 'p_' || r.b_profile_id::text END                  AS b_player_key,
      CASE WHEN r.b_has_login THEN 'registered' ELSE 'guest' END  AS b_player_type,
      r.b_guest_player_id,
      r.b_guest_ids,
      r.b_profile_id,
      CASE WHEN r.b_merged THEN coalesce(nullif(btrim(pe.full_name), ''), r.b_full_name) ELSE r.b_full_name END AS b_full_name,
      CASE WHEN r.b_merged THEN coalesce(nullif(pe.email, ''), r.b_email)   ELSE r.b_email END  AS b_email,
      CASE WHEN r.b_merged THEN coalesce(nullif(pe.phone, ''), r.b_phone)   ELSE r.b_phone END  AS b_phone,
      CASE WHEN r.b_merged THEN coalesce(pe.billing_business_name, r.b_billing_business_name) ELSE r.b_billing_business_name END AS b_billing_business_name,
      CASE WHEN r.b_merged THEN coalesce(pe.billing_address,       r.b_billing_address)       ELSE r.b_billing_address END       AS b_billing_address,
      CASE WHEN r.b_merged THEN coalesce(pe.billing_btw_number,    r.b_billing_btw_number)    ELSE r.b_billing_btw_number END    AS b_billing_btw_number,
      CASE WHEN r.b_merged THEN coalesce(pe.skill_rating, r.b_skill_rating) ELSE r.b_skill_rating END AS b_skill_rating,
      CASE WHEN r.b_merged THEN coalesce(nullif(pe.rating_system, ''), r.b_rating_system) ELSE r.b_rating_system END AS b_rating_system,
      r.b_notes,
      r.b_source,
      CASE WHEN r.b_merged THEN coalesce(pe.birth_date, r.b_birth_date) ELSE r.b_birth_date END AS b_birth_date,
      r.b_has_trained,
      r.b_created_at,
      r.b_owner_trainer_id
    FROM rolled r
    LEFT JOIN public.persons pe ON r.b_merged AND pe.id = r.b_person_id
  ),
  -- metadata joins PERSON-WIDE: tags union across the person's in-scope metadata rows;
  -- metadata_id + academy_notes are guest-side-first picks (edits keep landing on the
  -- roster-managed guest row, exactly where they landed before).
  with_meta AS (
    SELECT b.*,
           md.meta_id  AS b_metadata_id,
           coalesce(md.meta_tags, '{}'::uuid[]) AS b_tag_ids,
           md.meta_notes AS b_academy_notes
    FROM base b
    LEFT JOIN LATERAL (
      SELECT
        (SELECT m.id FROM public.academy_player_metadata m
          WHERE ((p_scope = 'academy' AND m.academy_profile_id  = p_scope_id)
              OR (p_scope = 'trainer' AND m.trainer_profile_id = p_scope_id))
            AND (m.guest_player_id = ANY (b.b_guest_ids)
              OR (b.b_profile_id IS NOT NULL AND m.profile_id = b.b_profile_id))
          ORDER BY (m.guest_player_id IS NULL), m.created_at LIMIT 1) AS meta_id,
        (SELECT array_agg(DISTINCT t ORDER BY t)
           FROM public.academy_player_metadata m,
                LATERAL unnest(coalesce(m.tag_ids, '{}'::uuid[])) t
          WHERE ((p_scope = 'academy' AND m.academy_profile_id  = p_scope_id)
              OR (p_scope = 'trainer' AND m.trainer_profile_id = p_scope_id))
            AND (m.guest_player_id = ANY (b.b_guest_ids)
              OR (b.b_profile_id IS NOT NULL AND m.profile_id = b.b_profile_id))) AS meta_tags,
        (SELECT m.notes FROM public.academy_player_metadata m
          WHERE ((p_scope = 'academy' AND m.academy_profile_id  = p_scope_id)
              OR (p_scope = 'trainer' AND m.trainer_profile_id = p_scope_id))
            AND (m.guest_player_id = ANY (b.b_guest_ids)
              OR (b.b_profile_id IS NOT NULL AND m.profile_id = b.b_profile_id))
            AND m.notes IS NOT NULL
          ORDER BY (m.guest_player_id IS NULL), m.created_at LIMIT 1) AS meta_notes
    ) md ON true
  ),
  filtered AS (
    SELECT w.*
    FROM with_meta w
    WHERE
      -- search: every token must match folded name/email/business/phone text,
      -- or (>= 3 digits) the digits-normalized phone
      (v_tokens IS NULL OR NOT EXISTS (
        SELECT 1 FROM unnest(v_tokens) tok
        WHERE tok <> ''
          AND NOT (
            public.fold_search_text(
              w.b_full_name || ' ' || w.b_email || ' '
              || coalesce(w.b_billing_business_name, '') || ' ' || w.b_phone
            ) LIKE '%' || tok || '%'
            OR (length(public.digits_only(tok)) >= 3
                AND public.digits_only(w.b_phone) LIKE '%' || public.digits_only(tok) || '%')
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
        OR w.b_owner_trainer_id = v_filter_trainer
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
    coalesce(enr.trainer_ids, CASE WHEN c.b_owner_trainer_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[c.b_owner_trainer_id] END),
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
               SELECT c.b_owner_trainer_id WHERE c.b_owner_trainer_id IS NOT NULL) t)
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
    SELECT EXISTS (
      SELECT 1 FROM public.email_address_state s
      WHERE s.email = lower(btrim(c.b_email))
        AND s.state IN ('hard_bounced','complained')
    ) AS email_undeliverable
  ) eb ON true;
END;
$$;

COMMENT ON FUNCTION public.get_players_overview(text, uuid, text, jsonb, text, text, integer, integer) IS
  'Players overview (academy/trainer scope), ONE ROW PER PERSON (person-unification Phase 3.2): in-scope guests + registered profiles resolve through person_links (split-frozen guests + unlinked rows key as themselves); merged rows carry both keys + persons-table identity; player_key stays g_/p_-parseable (guest-preferred), person_id is the unification key. Activity matching is ref-set based with the FAM-02 pure-profile guard (invoices keep the addressee exemption). Membership predicate deliberately unchanged this phase. Server-side search/filters/sort/pagination. SECURITY DEFINER with explicit scope authorization.';

REVOKE ALL ON FUNCTION public.get_players_overview(text, uuid, text, jsonb, text, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_players_overview(text, uuid, text, jsonb, text, text, integer, integer) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3) get_academy_cyclus_groups — roster names keyed by PERSON
-- ---------------------------------------------------------------------------
-- Return columns unchanged; re-emitted verbatim from 20260820100000 except the
-- snames/intake person-key CTEs (see each CTE's comment).
CREATE OR REPLACE FUNCTION public.get_academy_cyclus_groups(p_academy_id uuid)
RETURNS TABLE (
  cyclus_id             uuid,
  group_suffix          text,
  trainer_id            uuid,
  trainer_name          text,
  has_cycle_row         boolean,
  is_registration       boolean,
  cycle_name            text,
  cyclus_name_fallback  text,
  location_name         text,
  sessions              integer,
  max_booked            integer,
  player_names          text[],
  player_count          integer,
  price_per_session     numeric,
  max_participants      integer,
  first_slot_id         uuid,
  is_public             boolean,
  status                text,
  group_type            text,
  kind                  text,
  category_id           uuid,
  category_name         text,
  category_color        text,
  period_start          timestamptz,
  period_end            timestamptz,
  payment_status_summary text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_tz text;
BEGIN
  IF p_academy_id NOT IN (SELECT public.get_user_academy_ids(auth.uid())) THEN
    RAISE EXCEPTION 'not_authorized_for_academy' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT COALESCE(ap.timezone, 'Europe/Amsterdam') INTO v_tz
  FROM public.academy_profiles ap WHERE ap.id = p_academy_id;
  v_tz := COALESCE(v_tz, 'Europe/Amsterdam');

  RETURN QUERY
  WITH tname AS (
  SELECT tp.id AS tid, p.full_name
  FROM public.trainer_profiles tp
  LEFT JOIN public.profiles p ON p.user_id = tp.user_id
  WHERE tp.id IN (
    SELECT DISTINCT sl.trainer_id
    FROM public.availability_slots sl
    WHERE sl.academy_profile_id = p_academy_id AND sl.trainer_id IS NOT NULL
  )
),
cyc AS (
  SELECT c.id, c.name, c.owner_id, c.owner_type, c.status, c.type, c.settings, c.category_id,
         c.start_date, c.end_date, c.price_per_session, c.location_id
  FROM public.cycles c
  WHERE (c.owner_type = 'academy' AND c.owner_id = p_academy_id)
     OR c.id IN (
       SELECT sl.cyclus_id
       FROM public.availability_slots sl
       WHERE sl.academy_profile_id = p_academy_id AND sl.cyclus_id IS NOT NULL
     )
),
s AS (
  SELECT
    sl.id, sl.start_time, sl.end_time, sl.max_participants, sl.is_public,
    sl.cyclus_id, sl.cyclus_name, sl.trainer_id, sl.price_per_session, sl.location_id,
    (c.id IS NOT NULL)                AS has_cycle_row,
    (c.type IS NOT DISTINCT FROM 'registration') AS is_registration,
    (c.settings->>'rebook_payment_mode' IS NOT NULL OR c.settings->>'rebook_round_id' IS NOT NULL) AS is_rebook,
    c.category_id                    AS cycle_category_id,
    c.name                           AS cycle_name,
    c.status                         AS cycle_status,
    c.type                           AS cycle_type,
    c.price_per_session              AS cycle_pps,
    CASE
      WHEN c.type = 'registration' THEN
        COALESCE(sl.trainer_id::text, '')
          || '::' || EXTRACT(DOW FROM sl.start_time AT TIME ZONE v_tz)::int::text
          || '::' || to_char(sl.start_time AT TIME ZONE v_tz, 'HH24:MI')
          || '-'  || to_char(sl.end_time   AT TIME ZONE v_tz, 'HH24:MI')
      ELSE COALESCE(sl.trainer_id::text, '')
    END                              AS group_suffix
  FROM public.availability_slots sl
  LEFT JOIN cyc c ON c.id = sl.cyclus_id
  WHERE sl.academy_profile_id = p_academy_id AND sl.cyclus_id IS NOT NULL
),
sb AS (
  SELECT
    b.slot_id,
    count(*) FILTER (WHERE public.booking_occupies_seat(b.status, b.hold_expires_at)) AS booked_count,
    count(*) FILTER (WHERE b.status IN ('confirmed','pending')) AS active_count,
    count(*) FILTER (WHERE b.status IN ('confirmed','pending')
                       AND (b.payment_status = 'paid' OR b.paid_externally IS TRUE)) AS active_paid_count
  FROM public.bookings b
  WHERE b.slot_id IN (SELECT id FROM s)
  GROUP BY b.slot_id
),
-- Phase 3.2 (person-unify): the roster unit is the PERSON. Keys resolve through
-- person_links — FAM-02 guest-first on dual-keyed rows; a split-frozen guest keys as
-- ITSELF (its link is suspended while the review is pending); unlinked rows key as their
-- source uuid (congruent with deterministic person ids). A linked row's display name is
-- the persons row's (same source the cycle-detail roster shows), side name as fallback.
snames AS (
  SELECT DISTINCT x.cyclus_id, x.group_suffix, x.person_key, x.name FROM (
    SELECT
      s.cyclus_id,
      s.group_suffix,
      (CASE WHEN b.guest_player_id IS NOT NULL
            THEN CASE WHEN plg.person_id IS NOT NULL AND NOT public.is_guest_split_frozen(b.guest_player_id)
                      THEN plg.person_id ELSE b.guest_player_id END
            ELSE COALESCE(plp.person_id, b.player_id) END)::text AS person_key,
      CASE WHEN b.guest_player_id IS NOT NULL
           THEN CASE WHEN plg.person_id IS NOT NULL AND NOT public.is_guest_split_frozen(b.guest_player_id)
                     THEN COALESCE(NULLIF(BTRIM(peg.full_name), ''), gp.full_name, pp.full_name)
                     ELSE COALESCE(gp.full_name, pp.full_name) END
           ELSE COALESCE(NULLIF(BTRIM(pep.full_name), ''), pp.full_name) END AS name
    FROM public.bookings b
    JOIN s ON s.id = b.slot_id
    LEFT JOIN public.profiles pp ON pp.id = b.player_id
    LEFT JOIN public.guest_players gp ON gp.id = b.guest_player_id
    LEFT JOIN public.person_links plg ON plg.guest_player_id = b.guest_player_id
    LEFT JOIN public.persons peg ON peg.id = plg.person_id
    LEFT JOIN public.person_links plp ON plp.profile_id = b.player_id AND b.guest_player_id IS NULL
    LEFT JOIN public.persons pep ON pep.id = plp.person_id
    WHERE b.status IN ('confirmed','pending','pending_approval')
      AND (b.player_id IS NOT NULL OR b.guest_player_id IS NOT NULL)
  ) x
  WHERE x.name IS NOT NULL
),
-- intake rows person-keyed exactly like snames (so a person both intaken and booked in a
-- group dedups by KEY now, not only by the historical name-equality suppression).
intake AS (
  SELECT DISTINCT x.cycle_id, x.person_key, x.name FROM (
    SELECT
      ir.cycle_id,
      (CASE WHEN ir.guest_player_id IS NOT NULL
            THEN CASE WHEN plg.person_id IS NOT NULL AND NOT public.is_guest_split_frozen(ir.guest_player_id)
                      THEN plg.person_id ELSE ir.guest_player_id END
            ELSE COALESCE(plp.person_id, ir.player_id) END)::text AS person_key,
      CASE WHEN ir.guest_player_id IS NOT NULL
           THEN CASE WHEN plg.person_id IS NOT NULL AND NOT public.is_guest_split_frozen(ir.guest_player_id)
                     THEN COALESCE(NULLIF(BTRIM(peg.full_name), ''), gp.full_name, pp.full_name)
                     ELSE COALESCE(gp.full_name, pp.full_name) END
           ELSE COALESCE(NULLIF(BTRIM(pep.full_name), ''), pp.full_name) END AS name
    FROM public.intake_requests ir
    LEFT JOIN public.profiles pp ON pp.id = ir.player_id
    LEFT JOIN public.guest_players gp ON gp.id = ir.guest_player_id
    LEFT JOIN public.person_links plg ON plg.guest_player_id = ir.guest_player_id
    LEFT JOIN public.persons peg ON peg.id = plg.person_id
    LEFT JOIN public.person_links plp ON plp.profile_id = ir.player_id AND ir.guest_player_id IS NULL
    LEFT JOIN public.persons pep ON pep.id = plp.person_id
    WHERE ir.cycle_id IN (SELECT id FROM cyc)
      AND ir.status IN ('confirmed','booked','pending')
      AND (ir.player_id IS NOT NULL OR ir.guest_player_id IS NOT NULL)
  ) x
  WHERE x.name IS NOT NULL
),
g AS (
  SELECT
    s.cyclus_id,
    s.group_suffix,
    (array_agg(s.trainer_id) FILTER (WHERE s.trainer_id IS NOT NULL))[1] AS trainer_id,
    bool_or(s.has_cycle_row)   AS has_cycle_row,
    bool_or(s.is_registration) AS is_registration,
    bool_or(s.is_rebook)       AS is_rebook,
    (array_agg(s.cycle_category_id) FILTER (WHERE s.cycle_category_id IS NOT NULL))[1] AS category_id,
    max(s.cycle_name)          AS cycle_name,
    (array_agg(s.cyclus_name ORDER BY s.start_time NULLS LAST))[1] AS cyclus_name_fallback,
    count(*)::int              AS sessions,
    COALESCE(max(sb.booked_count), 0)::int AS max_booked,
    bool_or(s.is_public)       AS is_public,
    (array_agg(s.max_participants ORDER BY s.start_time NULLS LAST))[1] AS max_participants,
    COALESCE(max(s.cycle_pps), (array_agg(s.price_per_session ORDER BY s.start_time NULLS LAST))[1]) AS price_per_session,
    (array_agg(s.id ORDER BY s.start_time NULLS LAST))[1] AS first_slot_id,
    (array_agg(s.location_id ORDER BY s.start_time NULLS LAST))[1] AS location_id,
    min(s.start_time)          AS period_start,
    max(s.start_time)          AS period_end,
    max(s.cycle_status)        AS cycle_status,
    max(s.cycle_type)          AS cycle_type,
    COALESCE(sum(sb.active_count), 0)       AS active_count,
    COALESCE(sum(sb.active_paid_count), 0)  AS active_paid_count
  FROM s
  LEFT JOIN sb ON sb.slot_id = s.id
  GROUP BY s.cyclus_id, s.group_suffix
),
gnames AS (
  SELECT cyclus_id, group_suffix, array_agg(name ORDER BY name) AS player_names
  FROM (
    SELECT DISTINCT cyclus_id, group_suffix, person_key, name FROM (
      SELECT cyclus_id, group_suffix, person_key, name FROM snames
      UNION
      SELECT g.cyclus_id, g.group_suffix, i.person_key, i.name
      FROM g JOIN intake i ON i.cycle_id = g.cyclus_id
      WHERE g.is_registration IS NOT TRUE
        AND NOT EXISTS (
          SELECT 1 FROM snames sn
          WHERE sn.cyclus_id = g.cyclus_id
            AND sn.group_suffix = g.group_suffix
            AND sn.name = i.name
        )
    ) u
  ) d
  GROUP BY cyclus_id, group_suffix
)
-- ── slot-backed groups ──
SELECT
  g.cyclus_id,
  g.group_suffix,
  g.trainer_id,
  COALESCE(tn.full_name, 'Unknown') AS trainer_name,
  g.has_cycle_row,
  g.is_registration,
  g.cycle_name,
  g.cyclus_name_fallback,
  loc.name AS location_name,
  g.sessions,
  g.max_booked,
  COALESCE(gn.player_names, ARRAY[]::text[]) AS player_names,
  COALESCE(array_length(gn.player_names, 1), 0) AS player_count,
  g.price_per_session,
  COALESCE(g.max_participants, 4) AS max_participants,
  g.first_slot_id,
  g.is_public,
  CASE WHEN g.has_cycle_row THEN COALESCE(g.cycle_status, 'draft') ELSE 'active' END AS status,
  CASE
    WHEN NOT g.has_cycle_row THEN 'cyclus'
    WHEN g.is_registration THEN 'cyclus'
    ELSE COALESCE(g.cycle_type, 'cyclus')
  END AS group_type,
  CASE
    WHEN g.is_rebook THEN 'rebook'
    WHEN g.is_registration THEN 'registration'
    WHEN g.cycle_type = 'event' THEN 'event'
    ELSE 'cyclus'
  END AS kind,
  g.category_id,
  cat.name  AS category_name,
  cat.color AS category_color,
  g.period_start,
  g.period_end,
  CASE
    WHEN g.active_count = 0 THEN 'no_players'
    WHEN g.active_paid_count = g.active_count THEN 'all_paid'
    ELSE 'has_unpaid'
  END AS payment_status_summary
FROM g
LEFT JOIN tname tn ON tn.tid = g.trainer_id
LEFT JOIN public.locations loc ON loc.id = g.location_id
LEFT JOIN public.academy_cycle_categories cat ON cat.id = g.category_id
LEFT JOIN gnames gn ON gn.cyclus_id = g.cyclus_id AND gn.group_suffix = g.group_suffix

UNION ALL

-- ── real cycles with NO slots (non-registration only; intake players, sessions=0) ──
SELECT
  c.id AS cyclus_id,
  COALESCE(CASE WHEN c.owner_type = 'trainer' THEN c.owner_id::text END, '') AS group_suffix,
  CASE WHEN c.owner_type = 'trainer' THEN c.owner_id END AS trainer_id,
  COALESCE(tn.full_name, 'Unknown') AS trainer_name,
  true  AS has_cycle_row,
  false AS is_registration,
  c.name AS cycle_name,
  NULL::text AS cyclus_name_fallback,
  loc.name AS location_name,
  0 AS sessions,
  0 AS max_booked,
  COALESCE(ci.player_names, ARRAY[]::text[]) AS player_names,
  COALESCE(array_length(ci.player_names, 1), 0) AS player_count,
  c.price_per_session,
  4 AS max_participants,
  NULL::uuid AS first_slot_id,
  false AS is_public,
  COALESCE(c.status, 'draft') AS status,
  COALESCE(c.type, 'cyclus') AS group_type,
  CASE
    WHEN (c.settings->>'rebook_payment_mode' IS NOT NULL OR c.settings->>'rebook_round_id' IS NOT NULL) THEN 'rebook'
    WHEN c.type = 'event' THEN 'event'
    ELSE 'cyclus'
  END AS kind,
  c.category_id,
  cat.name  AS category_name,
  cat.color AS category_color,
  COALESCE(c.start_date::timestamptz, now()) AS period_start,
  COALESCE(c.end_date::timestamptz, now()) AS period_end,
  'no_players' AS payment_status_summary
FROM cyc c
LEFT JOIN tname tn ON tn.tid = (CASE WHEN c.owner_type = 'trainer' THEN c.owner_id END)
LEFT JOIN public.locations loc ON loc.id = c.location_id
LEFT JOIN public.academy_cycle_categories cat ON cat.id = c.category_id
LEFT JOIN (
  SELECT cycle_id, array_agg(name ORDER BY name) AS player_names
  FROM intake GROUP BY cycle_id
) ci ON ci.cycle_id = c.id
WHERE c.type IS DISTINCT FROM 'registration'
  AND NOT EXISTS (SELECT 1 FROM s WHERE s.cyclus_id = c.id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_academy_cyclus_groups(uuid) TO authenticated;
