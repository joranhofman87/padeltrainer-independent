-- ============================================================================
-- Dashboard analytics — revenue = MONEY ACTUALLY COLLECTED (owner decision 2026-07-13)
-- ============================================================================
-- An academy reported ~€100k of "revenue" for a month that was nowhere near real. Root cause:
-- the revenue sum valued every paid seat at COALESCE(payment_amount, price_per_session, 0) — the
-- FULL court list-price whenever the per-seat amount was 0 or NULL. Covered group seats are
-- written payment_amount = NULL (rebook_group_manage: the captain pays the whole court ONCE,
-- 3 teammates ride for €0 of their own), so a captain-paid group of 4 reported ~4× the court
-- price; the same list-price fallback hit every NULL-amount legacy/subscription paid seat. It
-- also read bookings only, omitting registration/event/rebook INVOICE income. The earlier
-- revenue_truth fix (20260809100000) only rescued literal €0 seats — covered seats are NULL, so
-- it still inflated them, and it only added cycle_id overlay invoices (not rebook groups).
--
-- New definition — the euros actually received (Mollie OR cash/manually-marked-paid), each
-- counted ONCE, with NO list-price fallback:
--   (a) every PAID invoice's gross total. A paid invoice's total = Σ its booking_ids'
--       payment_amount (reconcile_payments #8), and it also carries booking-less overlay income
--       (registration/event cycle_id, rebook group/single). Summing paid invoices is therefore
--       the clean backbone across ALL income types with no per-seat inflation.
--   (b) PLUS paid bookings that are NOT on any of those paid invoices (money collected directly
--       on a booking, no invoice minted) — valued at their real payment_amount, never the slot
--       price. Covered group seats (paid_by_* set — their money is on the captain's invoice) are
--       excluded, and any booking already on a counted paid invoice is anti-joined out, so no
--       euro is double-counted.
-- Scope note: the trainer variant counts what is attributable to the trainer — invoices tagged to
-- them + non-covered per-seat booking money on their slots; an academy-collected group invoice is
-- the ACADEMY's revenue and shows on the academy dashboard, not doubled onto the trainer's.
-- Everything else (expenses, new-player, KPIs) is re-emitted verbatim from 20260809100000.
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
