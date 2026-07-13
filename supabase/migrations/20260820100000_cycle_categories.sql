-- ============================================================================
-- Cycle categories — a user-assigned, per-academy, colored label on a cycle
-- ============================================================================
-- The auto "Type" column (20260819100000) separates rebook / registration / event / cyclus, but
-- academies also run kinds the system can't know — kids programs, summer, competition, ladies.
-- This adds a single per-cycle Category from a managed, colored, per-academy catalog (mirrors the
-- player-tags pattern, but ONE value per cycle so it sorts cleanly as an overview column). The
-- overview surfaces it as a sortable + filterable colored column with inline assign.
-- ============================================================================

-- Catalog: the academy's own category list (name + color from the shared 8-color palette).
CREATE TABLE IF NOT EXISTS public.academy_cycle_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  academy_profile_id uuid NOT NULL,
  name text NOT NULL,
  color text NOT NULL DEFAULT 'slate',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (academy_profile_id, name)
);
CREATE INDEX IF NOT EXISTS idx_academy_cycle_categories_academy ON public.academy_cycle_categories(academy_profile_id);

ALTER TABLE public.academy_cycle_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Academy managers manage cycle categories"
ON public.academy_cycle_categories
FOR ALL
TO authenticated
USING (public.is_academy_manager(auth.uid(), academy_profile_id))
WITH CHECK (public.is_academy_manager(auth.uid(), academy_profile_id));

CREATE TRIGGER update_academy_cycle_categories_updated_at
BEFORE UPDATE ON public.academy_cycle_categories
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- The assignment: a single category per cycle. ON DELETE SET NULL so deleting a category just
-- un-categorizes its cycles (never cascades a cycle away).
ALTER TABLE public.cycles
  ADD COLUMN IF NOT EXISTS category_id uuid REFERENCES public.academy_cycle_categories(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_cycles_category_id ON public.cycles(category_id);

-- ── Re-emit get_academy_cyclus_groups to also return the category (id/name/color) ──────────────
-- Return type gains 3 columns → DROP + recreate (CREATE OR REPLACE cannot change return type).
-- Built on 20260819100000 (kind); everything else verbatim.
DROP FUNCTION IF EXISTS public.get_academy_cyclus_groups(uuid);

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
snames AS (
  SELECT DISTINCT
    s.cyclus_id,
    s.group_suffix,
    CASE WHEN b.guest_player_id IS NOT NULL THEN 'g:' || b.guest_player_id::text
         ELSE 'p:' || b.player_id::text END AS person_key,
    CASE WHEN b.guest_player_id IS NOT NULL THEN COALESCE(gp.full_name, pp.full_name)
         ELSE pp.full_name END AS name
  FROM public.bookings b
  JOIN s ON s.id = b.slot_id
  LEFT JOIN public.profiles pp ON pp.id = b.player_id
  LEFT JOIN public.guest_players gp ON gp.id = b.guest_player_id
  WHERE b.status IN ('confirmed','pending','pending_approval')
    AND (b.player_id IS NOT NULL OR b.guest_player_id IS NOT NULL)
    AND (CASE WHEN b.guest_player_id IS NOT NULL THEN COALESCE(gp.full_name, pp.full_name)
              ELSE pp.full_name END) IS NOT NULL
),
intake AS (
  SELECT DISTINCT
    ir.cycle_id,
    CASE WHEN ir.guest_player_id IS NOT NULL THEN 'g:' || ir.guest_player_id::text
         ELSE 'p:' || ir.player_id::text END AS person_key,
    CASE WHEN ir.guest_player_id IS NOT NULL THEN COALESCE(gp.full_name, pp.full_name)
         ELSE pp.full_name END AS name
  FROM public.intake_requests ir
  LEFT JOIN public.profiles pp ON pp.id = ir.player_id
  LEFT JOIN public.guest_players gp ON gp.id = ir.guest_player_id
  WHERE ir.cycle_id IN (SELECT id FROM cyc)
    AND ir.status IN ('confirmed','booked','pending')
    AND (ir.player_id IS NOT NULL OR ir.guest_player_id IS NOT NULL)
    AND (CASE WHEN ir.guest_player_id IS NOT NULL THEN COALESCE(gp.full_name, pp.full_name)
              ELSE pp.full_name END) IS NOT NULL
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
