-- ============================================================================
-- REBOOK · "sessions have opened" notifier for the second bucket
-- ============================================================================
-- When a rebook round's MEMBER window opens (priority window closed, member window
-- live) AND seats have freed up (someone didn't rebook), the second bucket — the
-- original-cohort non-rebookers + the registered priority list — should be emailed
-- that they can book now. This migration adds the detection + idempotency-claim
-- RPCs and a guarded pg_cron job that pokes the notify-rebook-member-open edge fn.
-- The edge fn computes the audience and sends (see _shared/rebook-member-open.ts).
-- ============================================================================

-- (1) Detection: rebook rounds whose member window is live, not yet notified, with
--     at least one freed seat (live occupancy < capacity — same predicate the
--     booking trigger uses). SECURITY DEFINER so the service-role edge fn can read
--     across academies.
CREATE OR REPLACE FUNCTION public.rebook_cycles_needing_member_open_notice()
RETURNS TABLE (cycle_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT c.id
  FROM public.cycles c
  WHERE c.owner_type = 'academy'
    AND (c.settings->>'rebook_payment_mode') IS NOT NULL          -- a rebook round
    AND (c.settings->>'rebook_member_open_notified_at') IS NULL    -- not yet notified
    AND EXISTS (
      SELECT 1
      FROM public.availability_slots s
      WHERE s.source_cycle_id = c.id
        AND s.member_window_ends_at IS NOT NULL
        AND s.priority_window_ends_at < now()                      -- priority window closed
        AND s.member_window_ends_at > now()                        -- member window still open
        AND (
          SELECT count(*)
          FROM public.bookings b
          WHERE b.slot_id = s.id
            AND (
              COALESCE(b.status, 'confirmed') IN ('confirmed', 'pending', 'pending_approval')
              OR (b.status = 'payment_pending' AND b.hold_expires_at IS NOT NULL AND b.hold_expires_at > now())
            )
        ) < COALESCE(s.max_participants, 1)                        -- a freed seat exists
    );
$$;

-- (2) Idempotency claim: stamp rebook_member_open_notified_at IF NULL, atomically.
--     Returns true to the winner, false to a concurrent run — so overlapping cron
--     ticks can never double-send.
CREATE OR REPLACE FUNCTION public.claim_rebook_member_open_notice(_cycle_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH upd AS (
    UPDATE public.cycles
    SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{rebook_member_open_notified_at}', to_jsonb(now()))
    WHERE id = _cycle_id
      AND (settings->>'rebook_member_open_notified_at') IS NULL
    RETURNING id
  )
  SELECT EXISTS (SELECT 1 FROM upd);
$$;

-- (3) Release the claim (set the marker back to json null → ->> yields SQL NULL →
--     re-eligible) when a round's send fails entirely, so the next tick retries.
CREATE OR REPLACE FUNCTION public.unclaim_rebook_member_open_notice(_cycle_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.cycles
  SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{rebook_member_open_notified_at}', 'null'::jsonb)
  WHERE id = _cycle_id;
$$;

REVOKE ALL ON FUNCTION public.rebook_cycles_needing_member_open_notice() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_rebook_member_open_notice(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.unclaim_rebook_member_open_notice(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rebook_cycles_needing_member_open_notice() TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_rebook_member_open_notice(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.unclaim_rebook_member_open_notice(uuid) TO service_role;

-- (4) Schedule the notifier every 15 minutes. Needs the service-role key (it pokes an
--     edge fn over HTTP), so it mirrors the invoice-health-check wrapper. Guarded on
--     pg_cron + the key being present so a fresh `db reset` / CI resets cleanly.
DO $$
DECLARE
  sr_key text;
  cron_command text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not installed — skipping notify-rebook-member-open schedule';
    RETURN;
  END IF;

  sr_key := current_setting('app.settings.service_role_key', true);
  IF sr_key IS NULL OR sr_key = '' THEN
    RAISE NOTICE 'app.settings.service_role_key not set — skipping notify-rebook-member-open schedule';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'notify-rebook-member-open') THEN
    PERFORM cron.unschedule('notify-rebook-member-open');
  END IF;

  cron_command := format(
    $cmd$SELECT net.http_post(
      url := 'https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/notify-rebook-member-open',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer %s'
      ),
      body := '{}'::jsonb
    ) AS request_id;$cmd$,
    sr_key
  );

  PERFORM cron.schedule('notify-rebook-member-open', '*/15 * * * *', cron_command);
END $$;
