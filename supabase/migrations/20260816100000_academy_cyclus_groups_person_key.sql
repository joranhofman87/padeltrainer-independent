-- ============================================================================
-- get_academy_cyclus_groups — person-keyed roster + hold-aware booked_count
-- (audit Batch 5 §4.0 + FAM-02 Level 1 Batch 4)
-- ============================================================================
-- Two fixes to the overview RPC (return columns UNCHANGED):
--
--   • ROSTER BY PERSON, NOT BY NAME. The roster CTEs deduped players by the bare name string
--     (COALESCE(profile, guest)), so two DISTINCT people named "Jan de Vries" collapsed to one
--     entry and player_count under-counted; a linked guest's seat displayed the PROFILE's name.
--     Under FAM-02 Level 1 (guests and profiles are DISTINCT people; a dual-keyed row belongs to
--     the GUEST person) the roster now keys 'g:<guest_player_id>' / 'p:<player_id>' — mirroring
--     get_players_overview's g_/p_ keys and the frontend personIdentity module — and a dual-keyed
--     booking shows the guest's OWN name (profile name only as blank-name fallback). Two
--     same-named distinct people now count as 2 (Level-1-intended; reconciled via
--     merge_guest_players when they are genuinely one person). Intake rows are person-keyed the
--     same way; an intake whose NAME already appears among the group's booking names stays
--     suppressed (the historical intake↔booking merge for "registered as profile, booked as
--     guest" conversions — names are the only cross-source key there).
--
--   • HOLD-AWARE booked_count via ONE canonical predicate. booked_count counted
--     confirmed/pending/pending_approval only, while the DB capacity truth (booking RPCs,
--     delete/shrink guards, public occupancy) also counts live payment_pending holds — so a slot
--     mid-checkout read "0 booked" here yet was delete-protected and full to the public. The
--     canonical predicate now lives in public.booking_occupies_seat(status, hold_expires_at);
--     this RPC is its first consumer. The ~20 other SQL functions that inline the same predicate
--     should adopt the helper WHEN they are next re-emitted (do not mass-rewrite them here).
--     active_count / active_paid_count (payment semantics) are deliberately unchanged.
--
-- Everything else is re-emitted verbatim from 20260813100000 (academy tenant scoping intact).
-- ============================================================================

-- The ONE canonical "does this booking occupy a seat?" predicate (capacity statuses + a live
-- payment_pending hold). Keep in sync with src/lib/lessons.ts CAPACITY_OCCUPYING_STATUSES
-- (the TS mirror is deliberately hold-blind; holds are a server-side concept).
CREATE OR REPLACE FUNCTION public.booking_occupies_seat(p_status text, p_hold_expires_at timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(p_status, 'confirmed') IN ('confirmed', 'pending', 'pending_approval')
      OR (p_status = 'payment_pending' AND p_hold_expires_at IS NOT NULL AND p_hold_expires_at > now());
$$;

COMMENT ON FUNCTION public.booking_occupies_seat(text, timestamptz) IS
  'Canonical hold-aware occupying predicate (audit §4.0). Adoption target for the SQL functions that still inline it (enforce_booking_slot_tier, book_slot_for_payment, respond_to_priority_claim, rebook_group_apply/manage, apply_slot_delete/edit_to_cycle, get_public_slot_occupancy, …) — adopt on their next re-emission.';

-- (Functions default EXECUTE to PUBLIC; the helper is also called inside SECURITY DEFINER
-- functions, which run as owner. The explicit grant matches the repo convention.)
GRANT EXECUTE ON FUNCTION public.booking_occupies_seat(text, timestamptz) TO authenticated;

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
#variable_conflict use_column
DECLARE
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
  WITH tname AS (
  -- Names for EVERY trainer on the academy's OWN slots — active or departed (was active-only, so a
  -- departed trainer's groups showed 'Unknown').
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
  -- Academy-owned cycles + any cycle the academy's OWN slots belong to. NOT "cycles of trainers who
  -- also work here" — that leaked a shared trainer's OTHER academy's cycles + intake names.
  SELECT c.id, c.name, c.owner_id, c.owner_type, c.status, c.type,
         c.start_date, c.end_date, c.price_per_session, c.location_id
  FROM public.cycles c
  WHERE (c.owner_type = 'academy' AND c.owner_id = p_academy_id)
     OR c.id IN (
       SELECT sl.cyclus_id
       FROM public.availability_slots sl
       WHERE sl.academy_profile_id = p_academy_id AND sl.cyclus_id IS NOT NULL
     )
),
-- annotated slots scoped to the ACADEMY (academy_profile_id — the tenant boundary), never
-- "any slot whose trainer also works here".
s AS (
  SELECT
    sl.id, sl.start_time, sl.end_time, sl.max_participants, sl.is_public,
    sl.cyclus_id, sl.cyclus_name, sl.trainer_id, sl.price_per_session, sl.location_id,
    (c.id IS NOT NULL)                AS has_cycle_row,
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
  WHERE sl.academy_profile_id = p_academy_id AND sl.cyclus_id IS NOT NULL
),
-- per-slot booking aggregates. booked_count = the CANONICAL hold-aware occupying predicate
-- (booking_occupies_seat) so the overview badge agrees with the delete/shrink guards and the
-- public occupancy read; active_* keep their payment semantics (confirmed/pending only).
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
-- per-slot-group distinct PERSONS (FAM-02 Level 1): key 'g:<guest>' (a dual-keyed row belongs to
-- the GUEST person) else 'p:<player>'; name guest-first with profile fallback. Roster statuses
-- stay hold-blind (a mid-checkout hold has no name yet).
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
-- intake players per cycle (merged into NON-registration groups + no-slot cycles), person-keyed
-- exactly like snames.
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
-- aggregate slot-backed groups
g AS (
  SELECT
    s.cyclus_id,
    s.group_suffix,
    (array_agg(s.trainer_id) FILTER (WHERE s.trainer_id IS NOT NULL))[1] AS trainer_id,
    bool_or(s.has_cycle_row)   AS has_cycle_row,
    bool_or(s.is_registration) AS is_registration,
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
-- names per slot-backed group: its booking PERSONS + (non-registration) the cycle's intake
-- persons. An intake row is suppressed when its NAME already appears among the group's booking
-- names — the historical cross-source merge (an intake has no booking to share a person key
-- with, so the name is the only join). Two same-named DISTINCT booked persons stay two entries.
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
  -- intake is already DISTINCT per (cycle, person_key, name) → one name per person.
  SELECT cycle_id, array_agg(name ORDER BY name) AS player_names
  FROM intake GROUP BY cycle_id
) ci ON ci.cycle_id = c.id
WHERE c.type IS DISTINCT FROM 'registration'
  AND NOT EXISTS (SELECT 1 FROM s WHERE s.cyclus_id = c.id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_academy_cyclus_groups(uuid) TO authenticated;
