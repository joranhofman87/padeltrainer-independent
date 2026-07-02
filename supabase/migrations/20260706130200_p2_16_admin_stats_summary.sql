-- P2-16: server-side aggregation for get-admin-stats. Replaces six uncapped whole-table selects that
-- silently truncated at PostgREST's 1000-row cap. admin_stats_summary() returns ONE jsonb object with
-- the raw scalars the edge fn needs; the edge fn still derives avgFeeFlat, fees, and month LABELS in JS
-- (unchanged), so every field of the AdminStats response is preserved exactly.
--
-- Admin gate: has_role(auth.uid(),'admin') — the SAME repo convention as reconcile_payments
-- (20260705140000). It derives the caller from auth.uid(), NOT a client-supplied parameter, so it is
-- safe to GRANT EXECUTE to authenticated (the edge fn calls it on the user-scoped client). Month
-- bucketing uses UTC to match the Deno edge fn (new Date(year, month, 1) under Deno's UTC default).
CREATE OR REPLACE FUNCTION public.admin_stats_summary()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _now            timestamptz := now();
  _this_month     timestamptz := date_trunc('month', (_now AT TIME ZONE 'UTC')) AT TIME ZONE 'UTC';
  _last_month     timestamptz := (date_trunc('month', (_now AT TIME ZONE 'UTC')) - interval '1 month') AT TIME ZONE 'UTC';
  _last_month_end timestamptz := (date_trunc('month', (_now AT TIME ZONE 'UTC')) - interval '1 second') AT TIME ZONE 'UTC';
  _six_start      timestamptz := (date_trunc('month', (_now AT TIME ZONE 'UTC')) - interval '5 months') AT TIME ZONE 'UTC';
  _overview       jsonb;
  _tiers          jsonb;
  _trends         jsonb;
  _reg            jsonb;
  _monthly        jsonb;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Overview: GMV + booking counts (bookings), trainer/player/mollie/club counts.
  SELECT jsonb_build_object(
    'totalGMV', COALESCE(SUM(payment_amount) FILTER (WHERE payment_status = 'paid'), 0),
    'totalBookings', COUNT(*),
    'paidBookings', COUNT(*) FILTER (WHERE payment_status = 'paid')
  ) INTO _overview FROM public.bookings;

  _overview := _overview
    || jsonb_build_object('activeTrainers', (SELECT COUNT(*) FROM public.trainer_profiles))
    || jsonb_build_object('activePlayers', (SELECT COUNT(*) FROM public.profiles))
    || jsonb_build_object(
         'connectedAccounts', (SELECT COUNT(*) FROM public.trainer_mollie_accounts WHERE charges_enabled),
         'pendingAccounts',   (SELECT COUNT(*) FROM public.trainer_mollie_accounts WHERE NOT charges_enabled)
       )
    || (SELECT jsonb_build_object(
          'totalClubs', COUNT(*),
          'verifiedClubs', COUNT(*) FILTER (WHERE is_verified),
          'subscribedClubs', COUNT(*) FILTER (WHERE subscription_status = 'active'),
          'trialingClubs', COUNT(*) FILTER (
             WHERE subscription_status = 'trial' AND (trial_ends_at IS NULL OR trial_ends_at > _now)),
          'expiredTrialClubs', COUNT(*) FILTER (
             WHERE subscription_status IS DISTINCT FROM 'active' AND trial_ends_at IS NOT NULL AND trial_ends_at <= _now)
        ) FROM public.club_profiles);

  -- Trainer tier buckets: same mapping as the edge fn (professional|active -> professional, academy -> academy, else starter).
  SELECT jsonb_build_object(
    'professional', COUNT(*) FILTER (WHERE subscription_status IN ('professional', 'active')),
    'academy',      COUNT(*) FILTER (WHERE subscription_status = 'academy'),
    'starter',      COUNT(*) FILTER (WHERE subscription_status IS DISTINCT FROM 'professional'
                                       AND subscription_status IS DISTINCT FROM 'active'
                                       AND subscription_status IS DISTINCT FROM 'academy')
  ) INTO _tiers FROM public.trainer_profiles;

  -- Signup trends: this-month vs last-month created_at (UTC boundaries).
  SELECT jsonb_build_object(
    'trainersThisMonth', (SELECT COUNT(*) FROM public.trainer_profiles WHERE created_at >= _this_month),
    'trainersLastMonth', (SELECT COUNT(*) FROM public.trainer_profiles WHERE created_at >= _last_month AND created_at <= _last_month_end),
    'playersThisMonth',  (SELECT COUNT(*) FROM public.profiles WHERE created_at >= _this_month),
    'playersLastMonth',  (SELECT COUNT(*) FROM public.profiles WHERE created_at >= _last_month AND created_at <= _last_month_end)
  ) INTO _trends;

  -- Guest registrations.
  SELECT jsonb_build_object(
    'totalGuests', COUNT(*),
    'convertedToAccount', COUNT(*) FILTER (WHERE linked_profile_id IS NOT NULL),
    'hasTrained', COUNT(*) FILTER (WHERE has_trained),
    'thisMonth', COUNT(*) FILTER (WHERE created_at >= _this_month),
    'lastMonth', COUNT(*) FILTER (WHERE created_at >= _last_month AND created_at <= _last_month_end)
  ) INTO _reg FROM public.guest_players;

  -- Monthly gmv+bookings for the last 6 UTC months, keyed 'YYYY-MM' to match the edge fn's label loop.
  -- Buckets paid bookings by COALESCE(paid_at, created_at), same as the JS.
  SELECT COALESCE(jsonb_object_agg(m.k, jsonb_build_object('gmv', m.gmv, 'bookings', m.n)), '{}'::jsonb)
  INTO _monthly
  FROM (
    SELECT to_char(date_trunc('month', (COALESCE(paid_at, created_at) AT TIME ZONE 'UTC')), 'YYYY-MM') AS k,
           COALESCE(SUM(payment_amount), 0) AS gmv,
           COUNT(*) AS n
    FROM public.bookings
    WHERE payment_status = 'paid'
      AND COALESCE(paid_at, created_at) >= _six_start
    GROUP BY 1
  ) m;

  RETURN jsonb_build_object(
    'overview', _overview,
    'trainersByTier', _tiers,
    'signupTrends', _trends,
    'registrations', _reg,
    'monthly', _monthly
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_stats_summary() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_stats_summary() TO authenticated;
