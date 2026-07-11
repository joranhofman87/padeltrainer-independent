-- ============================================================================
-- REBOOK · per-round reminder lead time (settings.rebook_reminder_lead_hours)
-- ============================================================================
-- WHY: the automated non-responder reminder fired a fixed ~24h before each player's
-- priority deadline (the cron passes _lead_hours=24). Academies want to choose the
-- lead per round (e.g. 48h or 3 days before the deadline), set in the wizard and
-- editable afterwards via the round texts editor.
--
-- This re-emits rebook_claims_needing_auto_reminder VERBATIM from 20260724100000
-- (keeping the app_now() test clock) and only changes the lead-window comparison:
-- the cycle's own settings.rebook_reminder_lead_hours (digits-only parse — settings
-- are client-writable JSON, a junk value must fall back, not error the cron) wins
-- over the caller's _lead_hours, clamped to 1h..336h (14 days). Absent ⇒ exactly
-- the old behavior (caller's _lead_hours, default 24).
-- ============================================================================

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
    AND (c.settings->>'rebook_payment_mode') IS NOT NULL
    AND COALESCE((c.settings->>'rebook_auto_reminder')::boolean, true) = true
    AND spc.status = 'pending'
    AND spc.response_intent IS DISTINCT FROM 'decline'
    AND spc.reminded_at IS NULL
    AND s.priority_window_ends_at IS NOT NULL
    AND s.priority_window_ends_at > public.app_now()
    AND s.priority_window_ends_at <= public.app_now() + make_interval(hours => GREATEST(1, LEAST(336, COALESCE(
      CASE WHEN c.settings->>'rebook_reminder_lead_hours' ~ '^[0-9]{1,4}$'
           THEN (c.settings->>'rebook_reminder_lead_hours')::int END,
      _lead_hours, 24))))
    AND COALESCE(NULLIF(pr.email, ''), NULLIF(gp.email, '')) IS NOT NULL
  ORDER BY c.id,
           COALESCE(spc.player_id::text, 'g:' || spc.guest_player_id::text),
           s.priority_window_ends_at ASC;
$$;

REVOKE ALL ON FUNCTION public.rebook_claims_needing_auto_reminder(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rebook_claims_needing_auto_reminder(int) TO service_role;
