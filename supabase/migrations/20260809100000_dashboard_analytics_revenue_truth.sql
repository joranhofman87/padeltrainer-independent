-- ============================================================================
-- Dashboard analytics — revenue truth (audit 2026-07-11, Batch 2 / §4.5)
-- ============================================================================
-- Bug: the revenue sum used `COALESCE(NULLIF(b.payment_amount, 0), s.price_per_session, 0)`.
-- NULLIF turned a REAL €0 paid booking (a captain-covered group seat, a webhook writeback)
-- into NULL, so it fell back to the FULL slot price. A captain-paid group of 4 then reported
-- ~4× its real revenue (the captain's real amount + 3 phantom slot prices).
--
-- Fix 1: drop the NULLIF — `COALESCE(b.payment_amount, s.price_per_session, 0)`. A €0 stays €0
-- (the seat really collected nothing), while a genuinely NULL amount still falls back to the
-- slot price (legacy paid bookings with no stored per-player amount).
--
-- Fix 2: revenue read `bookings` only, so it OMITTED all registration/event sign-up-fee income.
-- Those overlay invoices are minted booking-less (`booking_ids = []`, `cycle_id` set — the only
-- insert that sets cycle_id; Theme 12) and the webhook writeback no-ops on empty booking_ids, so
-- their money never appears as a `bookings.payment_amount`. We UNION the paid overlay invoices
-- (`cycle_id IS NOT NULL`) into revenue by `paid_at` — disjoint from bookings, so no double-count.
-- Both `total` (invoice) and `payment_amount` (booking) are gross (VAT-inclusive), so they add cleanly.
-- ============================================================================

-- ---- Academy -----------------------------------------------------------------
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
  rev AS (
    SELECT ym, SUM(amount) AS revenue FROM (
      -- Training/rebook booking income (per-player payment_amount; €0 kept, NULL → slot price).
      SELECT to_char(date_trunc('month', b.paid_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS ym,
             COALESCE(b.payment_amount, s.price_per_session, 0) AS amount
      FROM public.bookings b
      JOIN public.availability_slots s ON s.id = b.slot_id
      WHERE s.academy_profile_id = _academy_profile_id
        AND b.payment_status = 'paid' AND b.paid_at IS NOT NULL
        AND (b.paid_at AT TIME ZONE 'UTC') >= v_start
      UNION ALL
      -- Registration/event sign-up-fee income: booking-less overlay invoices (cycle_id set),
      -- provably disjoint from the bookings above (Theme 12) — otherwise omitted entirely.
      SELECT to_char(date_trunc('month', i.paid_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS ym,
             COALESCE(i.total, 0) AS amount
      FROM public.invoices i
      WHERE i.academy_profile_id = _academy_profile_id
        AND i.cycle_id IS NOT NULL
        AND i.status = 'paid' AND i.paid_at IS NOT NULL
        AND (i.paid_at AT TIME ZONE 'UTC') >= v_start
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
    SELECT COALESCE(apl.profile_id::text, 'g:' || apl.guest_player_id::text) AS pkey,
           bool_or(apl.profile_id IS NOT NULL) AS is_registered,
           MIN(apl.created_at) AS first_at
    FROM public.academy_player_locations apl
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

-- ---- Trainer -----------------------------------------------------------------
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
  rev AS (
    SELECT ym, SUM(amount) AS revenue FROM (
      -- Training/rebook booking income (per-player payment_amount; €0 kept, NULL → slot price).
      SELECT to_char(date_trunc('month', b.paid_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS ym,
             COALESCE(b.payment_amount, s.price_per_session, 0) AS amount
      FROM public.bookings b
      JOIN public.availability_slots s ON s.id = b.slot_id
      WHERE s.trainer_id = v_trainer
        AND b.payment_status = 'paid' AND b.paid_at IS NOT NULL
        AND (b.paid_at AT TIME ZONE 'UTC') >= v_start
      UNION ALL
      -- Registration/event sign-up-fee income: booking-less overlay invoices (cycle_id set),
      -- provably disjoint from the bookings above (Theme 12) — otherwise omitted entirely.
      SELECT to_char(date_trunc('month', i.paid_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS ym,
             COALESCE(i.total, 0) AS amount
      FROM public.invoices i
      WHERE i.trainer_id = v_trainer
        AND i.cycle_id IS NOT NULL
        AND i.status = 'paid' AND i.paid_at IS NOT NULL
        AND (i.paid_at AT TIME ZONE 'UTC') >= v_start
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
    -- registered: first (non-cancelled) booking on one of this trainer's slots
    SELECT ('p:' || b.player_id::text) AS pkey, true AS is_registered, MIN(b.created_at) AS first_at
    FROM public.bookings b
    JOIN public.availability_slots s ON s.id = b.slot_id
    WHERE s.trainer_id = v_trainer AND b.player_id IS NOT NULL
      AND COALESCE(b.status, 'confirmed') NOT IN ('cancelled', 'cancelled_swap')
    GROUP BY b.player_id
    UNION ALL
    -- guests owned by this trainer
    SELECT ('g:' || gp.id::text), false, gp.created_at
    FROM public.guest_players gp WHERE gp.trainer_id = v_trainer
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

REVOKE ALL ON FUNCTION public.get_academy_dashboard_analytics(uuid, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_trainer_dashboard_analytics(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_academy_dashboard_analytics(uuid, int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_trainer_dashboard_analytics(int) TO authenticated, service_role;
-- Keep the anon lockdown self-contained across this re-CREATE (mirrors 20260720100000).
REVOKE EXECUTE ON FUNCTION public.get_academy_dashboard_analytics(uuid, int) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_trainer_dashboard_analytics(int) FROM anon;
