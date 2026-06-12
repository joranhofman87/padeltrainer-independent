-- P-03 (AUDIT-2026-06): pre-aggregate the filter facts in get_players_overview.
-- The trainer/location/active-cyclus/payment filters used correlated EXISTS
-- subplans re-scanning bookings JOIN scope_slots per candidate row (quadratic at
-- scale). They now hash-join per-identity aggregates computed once per call,
-- gated on the filter being active so the no-filter path is unaffected.
-- Full definition re-stated (CREATE OR REPLACE needs the whole body); behavior
-- parity is asserted by scripts/db/rehearse-players-overview.ts, whose contract
-- suite (incl. every filter and the linked-guest-via-profile cases) runs against
-- this revision.

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
    WHERE NOT EXISTS (SELECT 1 FROM guests g WHERE g.linked_profile_id = r.pid)
      AND NOT EXISTS (SELECT 1 FROM removed_meta rm WHERE rm.pid = r.pid)
  ),
  base AS (
    -- Guests: identity COALESCEd from the linked profile when present.
    SELECT
      'g_' || g.id                                                AS b_player_key,
      'guest'::text                                               AS b_player_type,
      g.id                                                        AS b_guest_player_id,
      g.linked_profile_id                                         AS b_profile_id,
      coalesce(nullif(btrim(lp.full_name), ''), g.full_name)      AS b_full_name,
      coalesce(nullif(btrim(lp.email), ''), g.email, '')          AS b_email,
      coalesce(nullif(btrim(lp.phone), ''), g.phone, '')          AS b_phone,
      coalesce(lp.billing_business_name, g.billing_business_name) AS b_billing_business_name,
      coalesce(lp.billing_address,       g.billing_address)       AS b_billing_address,
      coalesce(lp.billing_btw_number,    g.billing_btw_number)    AS b_billing_btw_number,
      coalesce(lp.skill_rating, g.skill_rating)                   AS b_skill_rating,
      coalesce(nullif(lp.rating_system, ''), g.rating_system, 'knltb') AS b_rating_system,
      g.notes                                                     AS b_notes,
      g.source                                                    AS b_source,
      coalesce(g.birth_date, lp.birth_date)                       AS b_birth_date,
      coalesce(g.has_trained, false)                              AS b_has_trained,
      g.created_at                                                AS b_created_at,
      g.trainer_id                                                AS b_owner_trainer_id
    FROM guests g
    LEFT JOIN public.profiles lp ON lp.id = g.linked_profile_id
    UNION ALL
    SELECT
      'p_' || p.id, 'registered', NULL::uuid, p.id,
      coalesce(nullif(btrim(p.full_name), ''), 'Unknown'),
      coalesce(p.email, ''), coalesce(p.phone, ''),
      p.billing_business_name, p.billing_address, p.billing_btw_number,
      p.skill_rating, coalesce(nullif(p.rating_system, ''), 'knltb'),
      NULL, NULL, p.birth_date, true, rv.first_booking_at, NULL::uuid
    FROM registered_visible rv
    JOIN public.profiles p ON p.id = rv.pid
  ),
  with_meta AS (
    -- P-01: the previous single LEFT JOIN matched metadata via an OR across two
    -- DIFFERENT equality columns (guest_player_id vs profile_id), which blocks
    -- hash joins and degrades to a quadratic nested loop (~1.8s first page at
    -- 10k players). The two arms are mutually exclusive per base row (guest
    -- rows never satisfy the registered arm and vice versa), so split into two
    -- hash-joinable LEFT JOINs and COALESCE the at-most-one match.
    SELECT b.*, coalesce(mg.id, mp.id) AS b_metadata_id,
           coalesce(mg.tag_ids, mp.tag_ids, '{}'::uuid[]) AS b_tag_ids,
           coalesce(mg.notes, mp.notes) AS b_academy_notes
    FROM base b
    LEFT JOIN public.academy_player_metadata mg
      ON mg.guest_player_id = b.b_guest_player_id
     AND ((p_scope = 'academy' AND mg.academy_profile_id  = p_scope_id)
       OR (p_scope = 'trainer' AND mg.trainer_profile_id = p_scope_id))
    LEFT JOIN public.academy_player_metadata mp
      ON b.b_player_type = 'registered'
     AND mp.profile_id = b.b_profile_id
     AND ((p_scope = 'academy' AND mp.academy_profile_id  = p_scope_id)
       OR (p_scope = 'trainer' AND mp.trainer_profile_id = p_scope_id))
  ),
  -- P-03: the trainer/location/cyclus/payment filters used correlated EXISTS
  -- subqueries that re-scanned bookings JOIN scope_slots per candidate row
  -- (quadratic; worst call 2.4s at 10k players). Pre-aggregate booking facts
  -- ONCE per identity and hash-join them. The CTEs are gated on the filters
  -- actually being active, so the common no-filter path stays empty/free.
  booking_facts AS (
    SELECT b.guest_player_id AS f_gid, b.player_id AS f_pid,
           ss.trainer_id, ss.location_id,
           (ss.cyclus_id IS NOT NULL AND ss.end_time >= now()) AS active_cyclus
    FROM public.bookings b JOIN scope_slots ss ON ss.id = b.slot_id
    WHERE b.status IN ('confirmed','completed')
      AND (v_filter_trainer IS NOT NULL OR v_filter_location IS NOT NULL OR v_has_cyclus IS NOT NULL)
  ),
  guest_facts AS (
    SELECT f_gid AS gid,
           array_agg(DISTINCT trainer_id)  FILTER (WHERE trainer_id  IS NOT NULL) AS trainer_ids,
           array_agg(DISTINCT location_id) FILTER (WHERE location_id IS NOT NULL) AS location_ids,
           bool_or(active_cyclus) AS has_active_cyclus
    FROM booking_facts WHERE f_gid IS NOT NULL GROUP BY f_gid
  ),
  profile_facts AS (
    SELECT f_pid AS pid,
           array_agg(DISTINCT trainer_id)  FILTER (WHERE trainer_id  IS NOT NULL) AS trainer_ids,
           array_agg(DISTINCT location_id) FILTER (WHERE location_id IS NOT NULL) AS location_ids,
           bool_or(active_cyclus) AS has_active_cyclus
    FROM booking_facts WHERE f_pid IS NOT NULL GROUP BY f_pid
  ),
  overdue_idents AS (
    SELECT i.guest_player_id AS o_gid, i.player_id AS o_pid
    FROM public.invoices i
    WHERE v_payment IS NOT NULL
      AND ((p_scope = 'academy' AND i.academy_profile_id = p_scope_id)
        OR (p_scope = 'trainer' AND i.trainer_id         = p_scope_id))
      AND (lower(i.status) = 'overdue'
        OR (i.due_date < current_date
            AND i.paid_at IS NULL
            AND lower(i.status) NOT IN ('paid','cancelled','draft','void')))
  ),
  overdue_guest   AS (SELECT DISTINCT o_gid AS gid FROM overdue_idents WHERE o_gid IS NOT NULL),
  overdue_profile AS (SELECT DISTINCT o_pid AS pid FROM overdue_idents WHERE o_pid IS NOT NULL),
  filtered AS (
    SELECT w.*
    FROM with_meta w
    LEFT JOIN guest_facts     gf ON gf.gid = w.b_guest_player_id
    LEFT JOIN profile_facts   pf ON pf.pid = w.b_profile_id
    LEFT JOIN overdue_guest   og ON og.gid = w.b_guest_player_id
    LEFT JOIN overdue_profile op ON op.pid = w.b_profile_id
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
      -- trainer (owner trainer OR any in-scope booking with that trainer)
      AND (v_filter_trainer IS NULL
        OR w.b_owner_trainer_id = v_filter_trainer
        OR v_filter_trainer = ANY (coalesce(gf.trainer_ids, '{}'::uuid[]) || coalesce(pf.trainer_ids, '{}'::uuid[])))
      -- training location
      AND (v_filter_location IS NULL
        OR v_filter_location = ANY (coalesce(gf.location_ids, '{}'::uuid[]) || coalesce(pf.location_ids, '{}'::uuid[])))
      -- active cyclus
      AND (v_has_cyclus IS NULL
        OR v_has_cyclus = (coalesce(gf.has_active_cyclus, false) OR coalesce(pf.has_active_cyclus, false)))
      -- payment status (parity with fetchOverduePayments: overdue = explicit
      -- status, or past due while not paid (status/paid_at) and not closed)
      AND (v_payment IS NULL
        OR (v_payment = 'overdue') = (og.gid IS NOT NULL OR op.pid IS NOT NULL))
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
    c.b_player_key, c.b_player_type, c.b_guest_player_id, c.b_profile_id,
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
    c.b_total_count
  FROM page c
  LEFT JOIN LATERAL (
    WITH pb AS (
      SELECT ss.trainer_id, ss.location_id, ss.cyclus_id, ss.end_time
      FROM public.bookings b JOIN scope_slots ss ON ss.id = b.slot_id
      WHERE b.status IN ('confirmed','completed')
        AND (b.guest_player_id = c.b_guest_player_id
          OR (c.b_profile_id IS NOT NULL AND b.player_id = c.b_profile_id))
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
      FROM (SELECT DISTINCT pb.location_id FROM pb WHERE pb.location_id IS NOT NULL) d
      JOIN public.locations l ON l.id = d.location_id
      WHERE p_scope = 'trainer'
         OR EXISTS (SELECT 1 FROM public.academy_locations al
                    WHERE al.academy_profile_id = p_scope_id
                      AND al.location_id = d.location_id
                      AND al.is_active)
    ) loc
  ) enr ON true
  LEFT JOIN LATERAL (
    SELECT EXISTS (
      SELECT 1 FROM public.invoices i
      WHERE ((p_scope = 'academy' AND i.academy_profile_id = p_scope_id)
          OR (p_scope = 'trainer' AND i.trainer_id         = p_scope_id))
        AND (i.guest_player_id = c.b_guest_player_id
          OR (c.b_profile_id IS NOT NULL AND i.player_id = c.b_profile_id))
        AND (lower(i.status) = 'overdue'
          OR (i.due_date < current_date
              AND i.paid_at IS NULL
              AND lower(i.status) NOT IN ('paid','cancelled','draft','void')))
    ) AS has_overdue_payment
  ) pay ON true;
END;
$$;

COMMENT ON FUNCTION public.get_players_overview(text, uuid, text, jsonb, text, text, integer, integer) IS
  'Players overview (academy/trainer scope): membership per the former client core (guests + registered, removal-filtered, linked-deduped), canonical linked-profile fields, server-side search/filters/sort/pagination. SECURITY DEFINER with explicit scope authorization.';

REVOKE ALL ON FUNCTION public.get_players_overview(text, uuid, text, jsonb, text, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_players_overview(text, uuid, text, jsonb, text, text, integer, integer) TO authenticated;
