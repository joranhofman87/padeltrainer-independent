-- ============================================================================
-- PHASE 3 · scale P0 — get_academy_cyclus_groups (server-side cycle-overview aggregation)
-- ============================================================================
--
-- AcademyCyclusOverview today fetches an academy's ENTIRE slot/booking/intake set
-- to the browser (1000/500-row chunked) and groups + derives payment status in
-- JS — it OOMs/thrashes at scale. This RPC does that aggregation in the DB and
-- returns the (small) set of grouped rows. The CLIENT keeps the light locale
-- formatting (Dutch day names, the registration labels) + its filter/sort, so
-- the fragile date-fns formatting is NOT reproduced in SQL (a hybrid split).
--
-- FAITHFUL to the JS grouping (3 tiers) + payment rule:
--   * real cycle, type!='registration', with slots -> one group per trainer
--     (group_suffix = trainer_id); merges the cycle's intake players.
--   * real cycle, type='registration', with slots -> one group per
--     trainer+weekday+time-window (group_suffix = trainer::dow::HH24:MI-HH24:MI);
--     NO intake merge.
--   * real cycle, no slots, type!='registration' -> one group (sessions=0),
--     intake players only. (registration-with-no-slots is SKIPPED, like the JS.)
--   * orphan slot group (cyclus_id with no cycles row) -> one group per trainer.
--   payment_status_summary: flatten the group's bookings; active = status IN
--     ('confirmed','pending'); 'no_players' if none active; 'all_paid' if every
--     active is paid (payment_status='paid' OR paid_externally); else 'has_unpaid'.
--     (booked_count / player names use the wider capacity set incl 'pending_approval'.)
--
-- The client builds group_key = cyclus_id || '::' || group_suffix and formats
-- day_time / the registration cyclus_name from period_start + player_names.
-- Owner-applied; INERT until AcademyCyclusOverview adopts it (with a client fallback).
-- ============================================================================

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
  period_start          timestamptz,
  period_end            timestamptz,
  payment_status_summary text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
-- The RETURNS TABLE output columns (status, cyclus_id, group_suffix, …) are in scope as
-- plpgsql variables; several CTEs reference same-named real columns (academy_trainers.status,
-- snames.cyclus_id, …). This function only RETURN QUERYs (never reads those names as variables),
-- so resolve every ambiguous reference to the COLUMN.
#variable_conflict use_column
DECLARE
  -- The registration weekly-series key (weekday + HH:MM) must be derived in the academy's
  -- LOCAL timezone to match the client: date-fns renders in the manager's browser tz, which for
  -- the NL academies is the club-local Europe/Amsterdam. Deriving it in UTC would split a single
  -- weekly series across a DST boundary into two groups. AT TIME ZONE is DST-correct per instant.
  v_tz text;
BEGIN
  -- SECURITY DEFINER bypasses RLS, so authorize the caller as a manager of this
  -- academy (else it's an IDOR exposing another academy's groups + player names).
  IF p_academy_id NOT IN (SELECT public.get_user_academy_ids(auth.uid())) THEN
    RAISE EXCEPTION 'not_authorized_for_academy' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT COALESCE(ap.timezone, 'Europe/Amsterdam') INTO v_tz
  FROM public.academy_profiles ap WHERE ap.id = p_academy_id;
  v_tz := COALESCE(v_tz, 'Europe/Amsterdam');

  RETURN QUERY
  WITH trainers AS (
  SELECT trainer_profile_id AS tid
  FROM public.academy_trainers
  WHERE academy_profile_id = p_academy_id AND status = 'active'
),
tname AS (
  SELECT tp.id AS tid, p.full_name
  FROM public.trainer_profiles tp
  JOIN trainers t ON t.tid = tp.id
  LEFT JOIN public.profiles p ON p.user_id = tp.user_id
),
cyc AS (
  SELECT c.id, c.name, c.owner_id, c.owner_type, c.status, c.type,
         c.start_date, c.end_date, c.price_per_session, c.location_id
  FROM public.cycles c
  WHERE (c.owner_type = 'academy' AND c.owner_id = p_academy_id)
     OR (c.owner_type = 'trainer' AND c.owner_id IN (SELECT tid FROM trainers))
),
-- annotated slots scoped to the academy's trainers
s AS (
  SELECT
    sl.id, sl.start_time, sl.end_time, sl.max_participants, sl.is_public,
    sl.cyclus_id, sl.cyclus_name, sl.trainer_id, sl.price_per_session, sl.location_id,
    (c.id IS NOT NULL)                AS has_cycle_row,
    -- NULL cycle type (and orphans) are non-registration, matching the JS `=== 'registration'`.
    (c.type IS NOT DISTINCT FROM 'registration') AS is_registration,
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
  WHERE sl.trainer_id IN (SELECT tid FROM trainers) AND sl.cyclus_id IS NOT NULL
),
-- per-slot booking aggregates (booked_count = capacity statuses; active_* = payment statuses)
sb AS (
  SELECT
    b.slot_id,
    count(*) FILTER (WHERE b.status IN ('confirmed','pending','pending_approval')) AS booked_count,
    count(*) FILTER (WHERE b.status IN ('confirmed','pending')) AS active_count,
    count(*) FILTER (WHERE b.status IN ('confirmed','pending')
                       AND (b.payment_status = 'paid' OR b.paid_externally IS TRUE)) AS active_paid_count
  FROM public.bookings b
  WHERE b.slot_id IN (SELECT id FROM s)
  GROUP BY b.slot_id
),
-- per-slot distinct player names (capacity statuses, name resolved profile OR guest)
snames AS (
  SELECT DISTINCT s.cyclus_id, s.group_suffix, COALESCE(pp.full_name, gp.full_name) AS name
  FROM public.bookings b
  JOIN s ON s.id = b.slot_id
  LEFT JOIN public.profiles pp ON pp.id = b.player_id
  LEFT JOIN public.guest_players gp ON gp.id = b.guest_player_id
  WHERE b.status IN ('confirmed','pending','pending_approval')
    AND COALESCE(pp.full_name, gp.full_name) IS NOT NULL
),
-- intake players per cycle (merged into NON-registration groups + no-slot cycles)
intake AS (
  SELECT DISTINCT ir.cycle_id, COALESCE(pp.full_name, gp.full_name) AS name
  FROM public.intake_requests ir
  LEFT JOIN public.profiles pp ON pp.id = ir.player_id
  LEFT JOIN public.guest_players gp ON gp.id = ir.guest_player_id
  WHERE ir.cycle_id IN (SELECT id FROM cyc)
    AND ir.status IN ('confirmed','booked','pending')
    AND COALESCE(pp.full_name, gp.full_name) IS NOT NULL
),
-- aggregate slot-backed groups
g AS (
  SELECT
    s.cyclus_id,
    s.group_suffix,
    (array_agg(s.trainer_id) FILTER (WHERE s.trainer_id IS NOT NULL))[1] AS trainer_id,
    bool_or(s.has_cycle_row)   AS has_cycle_row,
    bool_or(s.is_registration) AS is_registration,
    max(s.cycle_name)          AS cycle_name,
    -- earliest-slot's cyclus_name (the JS uses the first slot's), not the alphabetical max.
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
-- names per slot-backed group: its booking names + (non-registration) the cycle's intake names
gnames AS (
  SELECT cyclus_id, group_suffix, array_agg(name ORDER BY name) AS player_names
  FROM (
    SELECT DISTINCT cyclus_id, group_suffix, name FROM (
      SELECT cyclus_id, group_suffix, name FROM snames
      UNION
      SELECT g.cyclus_id, g.group_suffix, i.name
      FROM g JOIN intake i ON i.cycle_id = g.cyclus_id
      WHERE g.is_registration IS NOT TRUE
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
  COALESCE(c.start_date::timestamptz, now()) AS period_start,
  COALESCE(c.end_date::timestamptz, now()) AS period_end,
  'no_players' AS payment_status_summary
FROM cyc c
LEFT JOIN tname tn ON tn.tid = (CASE WHEN c.owner_type = 'trainer' THEN c.owner_id END)
LEFT JOIN public.locations loc ON loc.id = c.location_id
LEFT JOIN (
  SELECT cycle_id, array_agg(name ORDER BY name) AS player_names
  FROM intake GROUP BY cycle_id
) ci ON ci.cycle_id = c.id
-- IS DISTINCT FROM (not <>) so a NULL-type no-slot cycle is emitted, matching the JS which only
-- skips type === 'registration'.
WHERE c.type IS DISTINCT FROM 'registration'
  AND NOT EXISTS (SELECT 1 FROM s WHERE s.cyclus_id = c.id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_academy_cyclus_groups(uuid) TO authenticated;
