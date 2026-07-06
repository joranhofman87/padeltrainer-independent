-- Trainer-side audit P1 (privacy): the player SELECT policy on session_reports granted the
-- WHOLE trainer-role row to any player booked on the slot — including `notes` (the field the
-- attendance form labels "Private notes (not visible to players)") and the attendees array.
-- The app UI only ever selects public_notes, so the leak was invisible day-to-day, but any
-- booked player could read the private notes via PostgREST (`select=notes`). RLS is row-level;
-- column narrowing needs the established postgres-owned-view pattern (cycles_public /
-- profiles_public):
--
--   * session_reports_player_summaries — exposes ONLY (id, slot_id, reporter_role,
--     session_happened, public_notes, created_at) of TRAINER reports, scoped to slots the
--     caller holds a non-cancelled booking on (the old policy also let cancelled players read).
--   * the base-table player SELECT policy narrows to the player's OWN rows.
--
-- Trainer / academy-manager / admin policies are untouched — they legitimately read private
-- notes on their own slots. get_player_journey (SECURITY DEFINER) is unaffected.
--
-- Frontend pairing: sessionReports.fetchTrainerSlotSummaries reads the view with a graceful
-- fallback to the base table until this migration is applied (deploy-drift telemetry fires).

CREATE OR REPLACE VIEW public.session_reports_player_summaries AS
SELECT
  sr.id,
  sr.slot_id,
  sr.reporter_role,
  sr.session_happened,
  sr.public_notes,
  sr.created_at
FROM public.session_reports sr
WHERE sr.reporter_role = 'trainer'
  AND EXISTS (
    SELECT 1
    FROM public.bookings b
    WHERE b.slot_id = sr.slot_id
      AND b.player_id = public.get_profile_id_for_user(auth.uid())
      -- Canonical inactive-booking predicate (matches the capacity/visibility
      -- checks): swapped-away players (cancelled_swap) lose access too.
      AND COALESCE(b.status, 'confirmed') NOT IN ('cancelled', 'cancelled_swap')
  );

REVOKE ALL ON public.session_reports_player_summaries FROM anon;
GRANT SELECT ON public.session_reports_player_summaries TO authenticated;

DROP POLICY IF EXISTS "Players can view session reports for their bookings" ON public.session_reports;

DROP POLICY IF EXISTS "Players can view their own session reports" ON public.session_reports;
CREATE POLICY "Players can view their own session reports"
  ON public.session_reports
  FOR SELECT
  TO authenticated
  USING (session_reports.reporter_id = public.get_profile_id_for_user(auth.uid()));

-- Install assertions (no data mutation).
DO $$
DECLARE
  v_cols text[];
BEGIN
  -- The view must exist and expose EXACTLY the player-safe columns — `notes` and
  -- `attendees` must never slip in via a later CREATE OR REPLACE.
  SELECT array_agg(attname::text ORDER BY attname)
    INTO v_cols
  FROM pg_attribute
  WHERE attrelid = 'public.session_reports_player_summaries'::regclass
    AND attnum > 0
    AND NOT attisdropped;
  IF v_cols IS DISTINCT FROM ARRAY['created_at','id','public_notes','reporter_role','session_happened','slot_id'] THEN
    RAISE EXCEPTION 'session_reports_player_summaries exposes unexpected columns: %', v_cols;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'session_reports'
      AND policyname = 'Players can view session reports for their bookings'
  ) THEN
    RAISE EXCEPTION 'old row-wide player SELECT policy still present on session_reports';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'session_reports'
      AND policyname = 'Players can view their own session reports'
      AND cmd = 'SELECT'
      AND qual::text ILIKE '%get_profile_id_for_user%'
      AND qual::text NOT ILIKE '%reporter_role%'
  ) THEN
    RAISE EXCEPTION 'narrowed player SELECT policy missing or still role-widened on session_reports';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_views
    WHERE schemaname = 'public'
      AND viewname = 'session_reports_player_summaries'
      AND definition ILIKE '%cancelled_swap%'
  ) THEN
    RAISE EXCEPTION 'session_reports_player_summaries must exclude cancelled_swap bookings';
  END IF;
END $$;
