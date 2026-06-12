-- P-01 (AUDIT-2026-06): split the with_meta OR-join into two hash-joinable
-- LEFT JOINs. Identical behavior (see with_meta comment below); full definition
-- re-stated because CREATE OR REPLACE needs the whole body. Functional parity
-- is asserted by scripts/db/rehearse-players-overview.ts, which runs its entire
-- contract suite against this revision.

-- One Postgres-side source of truth for the academy/trainer players overview.
--
-- Membership rules mirror the client core this replaces (src/lib/unifiedPlayers.ts):
--   guests   = academy-level guests (academy_profile_id) + guests owned by the
--              academy's active trainers (trainer scope: trainer-owned), with
--              scope removal metadata (academy_player_metadata.removed_at) applied;
--   registered = profiles with a confirmed/completed booking on an in-scope
--              trainer's slot, deduped when a fetched guest carries
--              linked_profile_id, removal-filtered.
-- Identity fields for linked guests are COALESCEd from the live profile so the
-- overview can never show a stale guest copy; their profile's bookings and
-- invoices also count toward the merged row's filters and enrichment.
-- Search parity with src/lib/playerSearch.ts: diacritic-folded token-AND over
-- name/email/business/phone, plus digits-normalized phone matching (>= 3 digits).
-- Pagination: LIMIT/OFFSET with COUNT(*) OVER () AS total_count; total ordering
-- (sort key, lower(name), player_key) makes page-through deterministic.
-- SECURITY DEFINER with explicit scope authorization; RLS is intentionally
-- bypassed afterwards because every predicate is keyed to the validated scope id.

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
      -- trainer (owner trainer OR any in-scope booking with that trainer)
      AND (v_filter_trainer IS NULL
        OR w.b_owner_trainer_id = v_filter_trainer
        OR EXISTS (
          SELECT 1 FROM public.bookings b JOIN scope_slots ss ON ss.id = b.slot_id
          WHERE ss.trainer_id = v_filter_trainer
            AND b.status IN ('confirmed','completed')
            AND (b.guest_player_id = w.b_guest_player_id
              OR (w.b_profile_id IS NOT NULL AND b.player_id = w.b_profile_id))))
      -- training location
      AND (v_filter_location IS NULL OR EXISTS (
          SELECT 1 FROM public.bookings b JOIN scope_slots ss ON ss.id = b.slot_id
          WHERE ss.location_id = v_filter_location
            AND b.status IN ('confirmed','completed')
            AND (b.guest_player_id = w.b_guest_player_id
              OR (w.b_profile_id IS NOT NULL AND b.player_id = w.b_profile_id))))
      -- active cyclus
      AND (v_has_cyclus IS NULL OR v_has_cyclus = EXISTS (
          SELECT 1 FROM public.bookings b JOIN scope_slots ss ON ss.id = b.slot_id
          WHERE ss.cyclus_id IS NOT NULL AND ss.end_time >= now()
            AND b.status IN ('confirmed','completed')
            AND (b.guest_player_id = w.b_guest_player_id
              OR (w.b_profile_id IS NOT NULL AND b.player_id = w.b_profile_id))))
      -- payment status (parity with fetchOverduePayments: overdue = explicit
      -- status, or past due while not paid (status/paid_at) and not closed)
      AND (v_payment IS NULL OR (v_payment = 'overdue') = EXISTS (
          SELECT 1 FROM public.invoices i
          WHERE ((p_scope = 'academy' AND i.academy_profile_id = p_scope_id)
              OR (p_scope = 'trainer' AND i.trainer_id         = p_scope_id))
            AND (i.guest_player_id = w.b_guest_player_id
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
