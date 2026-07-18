-- Phase 3.6: PERSON-CORRECT dashboard head-counts (deferred from 3.5d).
--
-- PROBLEM: both dashboards' first_seen CTEs keyed "new players" on SEAT keys
-- (academy: academy_player_locations profile|guest key; trainer: 'p:'booking
-- player + every owned guest row) — a MERGED profile+guest person counted TWICE
-- (once registered + once guest), inflating the NewPlayersChart series and the
-- new_players_this/last_month KPI tiles.
--
-- FIX: both CTEs now key one row per PERSON, using the 3.5d person-key pattern:
--   * stamped person_id first (academy_player_locations carries the stamp;
--     bookings carry it; guest_players resolves via person_links);
--   * a SPLIT-FROZEN guest keys as its OWN accountless person — person_id stays
--     stamped during a pending review, so a plain COALESCE would fold the frozen
--     guest into a possibly-different human (the 3.5d/3.5c lesson);
--   * is_registered = the person has a LOGIN (persons.user_id, 3.3e doctrine)
--     on EVERY arm of both dashboards: a dual-key booking stamped to an
--     accountless guest person counts as a GUEST (FAM-02 — the seat shape does
--     not decide), and a linked guest whose person holds a login counts as
--     REGISTERED. Unstamped rows degrade to their seat shape (profile presence,
--     player_id booking = registered) — congruent pre-person behavior.
--
-- EVERYTHING ELSE IS RE-EMITTED VERBATIM from 20260818100000 (mechanically
-- copied from that file and CTE-substituted — the revenue money-collected
-- unions, expenses, KPIs and return shape are byte-identical; diff the two
-- files to audit). Return shapes unchanged → no types drift (both rpc calls are
-- cast client-side anyway). admin_stats_summary is DELIBERATELY untouched: its
-- head-counts are whole-table metrics (profiles vs guest_players) by design —
-- a "unique humans" metric would be a NEW persons count, not a rewrite.

CREATE OR REPLACE FUNCTION public.get_academy_dashboard_analytics(_academy_profile_id uuid, _months int DEFAULT 12)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_months int := GREATEST(1, LEAST(24, COALESCE(_months, 12)));
  v_start  timestamp := date_trunc('month', (now() AT TIME ZONE 'UTC')) - ((GREATEST(1, LEAST(24, COALESCE(_months, 12))) - 1) || ' months')::interval;
  v_this   text := to_char(date_trunc('month', (now() AT TIME ZONE 'UTC')), 'YYYY-MM');
  v_last   text := to_char(date_trunc('month', (now() AT TIME ZONE 'UTC')) - interval '1 month', 'YYYY-MM');
  v_result jsonb;
BEGIN
  IF NOT public.is_academy_manager(auth.uid(), _academy_profile_id) THEN
    RETURN NULL;
  END IF;

  WITH months AS (
    SELECT to_char(m, 'YYYY-MM') AS ym
    FROM generate_series(v_start, date_trunc('month', (now() AT TIME ZONE 'UTC')), interval '1 month') m
  ),
  -- Every id ever billed on one of this academy's PAID invoices → the anti-join set for (b),
  -- so a booking whose money is already inside a paid invoice's total is never counted twice.
  invoiced_bk AS (
    SELECT DISTINCT bid
    FROM public.invoices iv, unnest(COALESCE(iv.booking_ids, '{}'::uuid[])) AS bid
    WHERE iv.academy_profile_id = _academy_profile_id AND iv.status = 'paid'
  ),
  rev AS (
    SELECT ym, SUM(amount) AS revenue FROM (
      -- (a) every paid invoice's gross total (bucketed by when it was paid)
      SELECT to_char(date_trunc('month', i.paid_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS ym,
             COALESCE(i.total, 0) AS amount
      FROM public.invoices i
      WHERE i.academy_profile_id = _academy_profile_id
        AND i.status = 'paid' AND i.paid_at IS NOT NULL
        AND (i.paid_at AT TIME ZONE 'UTC') >= v_start
      UNION ALL
      -- (b) paid bookings not captured by any paid invoice, excluding covered group seats
      SELECT to_char(date_trunc('month', b.paid_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS ym,
             COALESCE(b.payment_amount, 0) AS amount
      FROM public.bookings b
      JOIN public.availability_slots s ON s.id = b.slot_id
      WHERE s.academy_profile_id = _academy_profile_id
        AND b.payment_status = 'paid' AND b.paid_at IS NOT NULL
        AND (b.paid_at AT TIME ZONE 'UTC') >= v_start
        AND b.paid_by_player_id IS NULL AND b.paid_by_guest_player_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM invoiced_bk ib WHERE ib.bid = b.id)
    ) u
    GROUP BY ym
  ),
  exp AS (
    SELECT to_char(date_trunc('month', e.expense_date::timestamp), 'YYYY-MM') AS ym, SUM(e.amount) AS expenses
    FROM public.expenses e
    WHERE e.academy_profile_id = _academy_profile_id AND e.expense_date >= v_start::date
    GROUP BY 1
  ),
  first_seen AS (
    -- Phase 3.6: one row per PERSON (was per seat-key — a merged profile+guest
    -- human counted twice: once registered + once guest). Person key = the 3.5d
    -- pattern: a split-frozen guest keys as its OWN person (person_id stays
    -- stamped during a pending review, so a plain COALESCE would fold the frozen
    -- guest into a possibly-different human). is_registered = the person has a
    -- login (persons.user_id, per the 3.3e doctrine), frozen rows never
    -- registered; unstamped rows degrade to profile-presence (congruent).
    SELECT CASE
             WHEN apl.guest_player_id IS NOT NULL AND public.is_guest_split_frozen(apl.guest_player_id)
               THEN 'g:' || apl.guest_player_id::text
             ELSE COALESCE(apl.person_id::text, apl.profile_id::text, 'g:' || apl.guest_player_id::text)
           END AS pkey,
           bool_or(CASE
             WHEN apl.guest_player_id IS NOT NULL AND public.is_guest_split_frozen(apl.guest_player_id)
               THEN false
             -- (pe.user_id IS NOT NULL) is never NULL, so a COALESCE fallback off it
             -- would be dead code — key the unstamped degradation on the JOIN hit.
             WHEN pe.id IS NOT NULL THEN pe.user_id IS NOT NULL
             ELSE apl.profile_id IS NOT NULL
           END) AS is_registered,
           MIN(apl.created_at) AS first_at
    FROM public.academy_player_locations apl
    LEFT JOIN public.persons pe ON pe.id = apl.person_id
    WHERE apl.academy_profile_id = _academy_profile_id
    GROUP BY 1
  ),
  players AS (
    SELECT to_char(date_trunc('month', first_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS ym,
           COUNT(*) FILTER (WHERE is_registered) AS new_registered,
           COUNT(*) FILTER (WHERE NOT is_registered) AS new_guest
    FROM first_seen
    GROUP BY 1
  ),
  merged AS (
    SELECT mo.ym,
           COALESCE(rev.revenue, 0)::numeric AS revenue,
           COALESCE(exp.expenses, 0)::numeric AS expenses,
           (COALESCE(rev.revenue, 0) - COALESCE(exp.expenses, 0))::numeric AS profit,
           COALESCE(players.new_registered, 0)::int AS new_registered,
           COALESCE(players.new_guest, 0)::int AS new_guest
    FROM months mo
    LEFT JOIN rev ON rev.ym = mo.ym
    LEFT JOIN exp ON exp.ym = mo.ym
    LEFT JOIN players ON players.ym = mo.ym
  )
  SELECT jsonb_build_object(
    'monthly', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.ym) FROM merged x), '[]'::jsonb),
    'kpis', jsonb_build_object(
      'revenue_this_month',    COALESCE((SELECT revenue  FROM merged WHERE ym = v_this), 0),
      'revenue_last_month',    COALESCE((SELECT revenue  FROM merged WHERE ym = v_last), 0),
      'expenses_this_month',   COALESCE((SELECT expenses FROM merged WHERE ym = v_this), 0),
      'new_players_this_month',COALESCE((SELECT new_registered + new_guest FROM merged WHERE ym = v_this), 0),
      'new_players_last_month',COALESCE((SELECT new_registered + new_guest FROM merged WHERE ym = v_last), 0),
      'outstanding_invoices',  (SELECT count(*) FROM public.invoices i WHERE i.academy_profile_id = _academy_profile_id AND COALESCE(i.status,'') NOT IN ('paid','cancelled','draft'))
    )
  ) INTO v_result;

  RETURN COALESCE(v_result, jsonb_build_object('monthly', '[]'::jsonb, 'kpis', '{}'::jsonb));
END;
$$;

CREATE OR REPLACE FUNCTION public.get_trainer_dashboard_analytics(_months int DEFAULT 12)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_months  int := GREATEST(1, LEAST(24, COALESCE(_months, 12)));
  v_start   timestamp := date_trunc('month', (now() AT TIME ZONE 'UTC')) - ((GREATEST(1, LEAST(24, COALESCE(_months, 12))) - 1) || ' months')::interval;
  v_this    text := to_char(date_trunc('month', (now() AT TIME ZONE 'UTC')), 'YYYY-MM');
  v_last    text := to_char(date_trunc('month', (now() AT TIME ZONE 'UTC')) - interval '1 month', 'YYYY-MM');
  v_trainer uuid;
  v_result  jsonb;
BEGIN
  SELECT id INTO v_trainer FROM public.trainer_profiles WHERE user_id = auth.uid() LIMIT 1;
  IF v_trainer IS NULL THEN
    RETURN NULL;
  END IF;

  WITH months AS (
    SELECT to_char(m, 'YYYY-MM') AS ym
    FROM generate_series(v_start, date_trunc('month', (now() AT TIME ZONE 'UTC')), interval '1 month') m
  ),
  -- Anti-join set = ids on this trainer's own PAID invoices (independent-trainer invoices);
  -- an academy-collected group invoice is academy-tagged, so it is NOT here and its covered
  -- seats are dropped from (b) by the paid_by_* filter instead — that money is the academy's.
  invoiced_bk AS (
    SELECT DISTINCT bid
    FROM public.invoices iv, unnest(COALESCE(iv.booking_ids, '{}'::uuid[])) AS bid
    WHERE iv.trainer_id = v_trainer AND iv.status = 'paid'
  ),
  rev AS (
    SELECT ym, SUM(amount) AS revenue FROM (
      -- (a) every paid invoice tagged to this trainer
      SELECT to_char(date_trunc('month', i.paid_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS ym,
             COALESCE(i.total, 0) AS amount
      FROM public.invoices i
      WHERE i.trainer_id = v_trainer
        AND i.status = 'paid' AND i.paid_at IS NOT NULL
        AND (i.paid_at AT TIME ZONE 'UTC') >= v_start
      UNION ALL
      -- (b) paid, non-covered per-seat booking money on this trainer's slots, not already invoiced
      SELECT to_char(date_trunc('month', b.paid_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS ym,
             COALESCE(b.payment_amount, 0) AS amount
      FROM public.bookings b
      JOIN public.availability_slots s ON s.id = b.slot_id
      WHERE s.trainer_id = v_trainer
        AND b.payment_status = 'paid' AND b.paid_at IS NOT NULL
        AND (b.paid_at AT TIME ZONE 'UTC') >= v_start
        AND b.paid_by_player_id IS NULL AND b.paid_by_guest_player_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM invoiced_bk ib WHERE ib.bid = b.id)
    ) u
    GROUP BY ym
  ),
  exp AS (
    SELECT to_char(date_trunc('month', e.expense_date::timestamp), 'YYYY-MM') AS ym, SUM(e.amount) AS expenses
    FROM public.expenses e
    WHERE e.trainer_id = v_trainer AND e.expense_date >= v_start::date
    GROUP BY 1
  ),
  first_seen AS (
    -- Phase 3.6: one row per PERSON (see the academy CTE note). The booking arm
    -- keeps its non-cancelled gate; a split-frozen guest keys as its own
    -- accountless person on BOTH arms. The guest arm resolves the guest's
    -- person via person_links (guest_players carries no person_id column).
    -- is_registered = the person's LOGIN on both arms (3.3e): a dual-key
    -- booking stamped to an accountless guest person is a GUEST (FAM-02 — the
    -- seat shape does not decide), and a linked guest whose person holds a
    -- login is REGISTERED. Unstamped rows degrade to their seat shape.
    SELECT pkey, bool_or(is_registered) AS is_registered, MIN(first_at) AS first_at
    FROM (
      -- bookings: first (non-cancelled) booking on one of this trainer's slots
      SELECT CASE
               WHEN b.guest_player_id IS NOT NULL AND public.is_guest_split_frozen(b.guest_player_id)
                 THEN 'g:' || b.guest_player_id::text
               ELSE COALESCE(b.person_id::text, 'p:' || b.player_id::text)
             END AS pkey,
             CASE
               WHEN b.guest_player_id IS NOT NULL AND public.is_guest_split_frozen(b.guest_player_id)
                 THEN false
               WHEN pe.id IS NOT NULL THEN pe.user_id IS NOT NULL
               ELSE true -- unstamped fallback: player_id booking = registered
             END AS is_registered,
             b.created_at AS first_at
      FROM public.bookings b
      JOIN public.availability_slots s ON s.id = b.slot_id
      LEFT JOIN public.persons pe ON pe.id = b.person_id
      WHERE s.trainer_id = v_trainer AND b.player_id IS NOT NULL
        AND COALESCE(b.status, 'confirmed') NOT IN ('cancelled', 'cancelled_swap')
      UNION ALL
      -- guests owned by this trainer
      SELECT CASE
               WHEN public.is_guest_split_frozen(gp.id) THEN 'g:' || gp.id::text
               ELSE COALESCE(pl.person_id::text, 'g:' || gp.id::text)
             END,
             CASE
               WHEN public.is_guest_split_frozen(gp.id) THEN false
               WHEN pe.id IS NOT NULL THEN pe.user_id IS NOT NULL
               ELSE false -- unlinked guest: accountless
             END,
             gp.created_at
      FROM public.guest_players gp
      LEFT JOIN public.person_links pl ON pl.guest_player_id = gp.id
      LEFT JOIN public.persons pe ON pe.id = pl.person_id
      WHERE gp.trainer_id = v_trainer
    ) u
    GROUP BY pkey
  ),
  players AS (
    SELECT to_char(date_trunc('month', first_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS ym,
           COUNT(*) FILTER (WHERE is_registered) AS new_registered,
           COUNT(*) FILTER (WHERE NOT is_registered) AS new_guest
    FROM first_seen
    GROUP BY 1
  ),
  merged AS (
    SELECT mo.ym,
           COALESCE(rev.revenue, 0)::numeric AS revenue,
           COALESCE(exp.expenses, 0)::numeric AS expenses,
           (COALESCE(rev.revenue, 0) - COALESCE(exp.expenses, 0))::numeric AS profit,
           COALESCE(players.new_registered, 0)::int AS new_registered,
           COALESCE(players.new_guest, 0)::int AS new_guest
    FROM months mo
    LEFT JOIN rev ON rev.ym = mo.ym
    LEFT JOIN exp ON exp.ym = mo.ym
    LEFT JOIN players ON players.ym = mo.ym
  )
  SELECT jsonb_build_object(
    'monthly', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.ym) FROM merged x), '[]'::jsonb),
    'kpis', jsonb_build_object(
      'revenue_this_month',    COALESCE((SELECT revenue  FROM merged WHERE ym = v_this), 0),
      'revenue_last_month',    COALESCE((SELECT revenue  FROM merged WHERE ym = v_last), 0),
      'expenses_this_month',   COALESCE((SELECT expenses FROM merged WHERE ym = v_this), 0),
      'new_players_this_month',COALESCE((SELECT new_registered + new_guest FROM merged WHERE ym = v_this), 0),
      'new_players_last_month',COALESCE((SELECT new_registered + new_guest FROM merged WHERE ym = v_last), 0),
      'outstanding_invoices',  (SELECT count(*) FROM public.invoices i WHERE i.trainer_id = v_trainer AND COALESCE(i.status,'') NOT IN ('paid','cancelled','draft'))
    )
  ) INTO v_result;

  RETURN COALESCE(v_result, jsonb_build_object('monthly', '[]'::jsonb, 'kpis', '{}'::jsonb));
END;
$$;

-- Keep the lockdown self-contained across this re-CREATE (mirrors 20260818100000):
-- CREATE OR REPLACE preserves the existing ACL, but if these functions are ever
-- re-created from scratch (squash, partial restore) the default ACL would grant
-- EXECUTE to PUBLIC including anon.
REVOKE ALL ON FUNCTION public.get_academy_dashboard_analytics(uuid, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_trainer_dashboard_analytics(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_academy_dashboard_analytics(uuid, int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_trainer_dashboard_analytics(int) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_academy_dashboard_analytics(uuid, int) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_trainer_dashboard_analytics(int) FROM anon;
