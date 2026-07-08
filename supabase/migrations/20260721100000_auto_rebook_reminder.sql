-- ============================================================================
-- REBOOK · automated reminder to NON-RESPONDERS before the priority deadline
-- ============================================================================
-- The owner can already send a manual reminder to non-responders from the manage
-- page. This adds an AUTOMATED one: an hourly pg_cron pokes the auto-rebook-reminder
-- edge fn, which emails invitees who have NOT yet responded (claim still 'pending',
-- did not decline) and whose PRIORITY window closes within the lead time — once each
-- (guarded by reminded_at, shared with the manual path). Opt-out per round via
-- cycles.settings.rebook_auto_reminder = false (default = on).
-- ============================================================================

-- (1) Detection: one representative (cycle, invitee) row per non-responder whose
--     priority window closes within `_lead_hours`, has an email, and has NOT been
--     reminded yet (manual OR auto — reminded_at is the single marker). SECURITY
--     DEFINER so the service-role edge fn can read recipient emails across academies.
CREATE OR REPLACE FUNCTION public.rebook_claims_needing_auto_reminder(_lead_hours int DEFAULT 24)
RETURNS TABLE (
  cycle_id uuid,
  cycle_name text,
  academy_name text,
  player_id uuid,
  guest_player_id uuid,
  recipient_name text,
  recipient_email text,
  claim_token text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT ON (c.id, COALESCE(spc.player_id::text, 'g:' || spc.guest_player_id::text))
    c.id AS cycle_id,
    c.name AS cycle_name,
    ap.name AS academy_name,
    spc.player_id,
    spc.guest_player_id,
    COALESCE(pr.full_name, gp.full_name) AS recipient_name,
    COALESCE(NULLIF(pr.email, ''), NULLIF(gp.email, '')) AS recipient_email,
    spc.claim_token
  FROM public.slot_priority_claims spc
  JOIN public.availability_slots s ON s.id = spc.slot_id
  JOIN public.cycles c ON c.id = s.cyclus_id
  JOIN public.academy_profiles ap ON ap.id = c.owner_id
  LEFT JOIN public.profiles pr ON pr.id = spc.player_id
  LEFT JOIN public.guest_players gp ON gp.id = spc.guest_player_id
  WHERE c.owner_type = 'academy'
    AND (c.settings->>'rebook_payment_mode') IS NOT NULL          -- a rebook round
    AND COALESCE((c.settings->>'rebook_auto_reminder')::boolean, true) = true  -- opt-out, default on
    AND spc.status = 'pending'                                    -- not booked (not 'claimed')
    AND spc.response_intent IS DISTINCT FROM 'decline'            -- did not say no
    AND spc.reminded_at IS NULL                                   -- not reminded yet (manual or auto)
    AND s.priority_window_ends_at IS NOT NULL
    AND s.priority_window_ends_at > now()                         -- window not closed yet
    AND s.priority_window_ends_at <= now() + make_interval(hours => GREATEST(1, LEAST(168, COALESCE(_lead_hours, 24))))
    AND COALESCE(NULLIF(pr.email, ''), NULLIF(gp.email, '')) IS NOT NULL  -- has an email
  ORDER BY c.id,
           COALESCE(spc.player_id::text, 'g:' || spc.guest_player_id::text),
           s.priority_window_ends_at ASC;                         -- earliest-closing slot as representative
$$;

REVOKE ALL ON FUNCTION public.rebook_claims_needing_auto_reminder(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rebook_claims_needing_auto_reminder(int) TO service_role;

-- (2) Schedule hourly. Needs the service-role key (it pokes an edge fn over HTTP);
--     mirrors the notify-rebook-member-open wrapper. Guarded on pg_cron + the key so a
--     fresh `db reset` / CI resets cleanly.
DO $$
DECLARE
  sr_key text;
  cron_command text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not installed — skipping auto-rebook-reminder schedule';
    RETURN;
  END IF;

  sr_key := current_setting('app.settings.service_role_key', true);
  IF sr_key IS NULL OR sr_key = '' THEN
    RAISE NOTICE 'app.settings.service_role_key not set — skipping auto-rebook-reminder schedule';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auto-rebook-reminder') THEN
    PERFORM cron.unschedule('auto-rebook-reminder');
  END IF;

  cron_command := format(
    $cmd$SELECT net.http_post(
      url := 'https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/auto-rebook-reminder',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer %s'
      ),
      body := '{}'::jsonb
    ) AS request_id;$cmd$,
    sr_key
  );

  -- Hourly, but only across a daytime UTC window (06:00–19:00 UTC) so it never wakes at
  -- deep night. That range covers every Amsterdam daytime hour in both CET and CEST; the
  -- edge fn's send-window guard is the exact local-time clamp (09:00–20:00 Amsterdam).
  PERFORM cron.schedule('auto-rebook-reminder', '0 6-19 * * *', cron_command);
END $$;
