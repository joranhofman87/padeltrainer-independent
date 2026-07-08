-- ============================================================================
-- TEST CLOCK · public.app_now() — an injectable "now" for deterministic time tests
-- ============================================================================
-- Time-dependent rebook logic (priority windows, deadlines, reminder eligibility) is hard
-- to test because it compares against now(). app_now() returns a per-session override when
-- the app.fake_now GUC is set, else the real now() — so a test can `set_config('app.fake_now',
-- '<iso>', false)` and travel to any instant. In PRODUCTION the GUC is never set, so app_now()
-- IS now() — a pure no-op. Empty-string is treated as unset (NULLIF) so a blank GUC never
-- errors the ::timestamptz cast.
--
-- Adoption is deliberately SCOPED: only the rebook auto-reminder detection RPC swaps now() →
-- app_now() here (the cheapest, self-contained target, letting us prove the pattern). Other
-- time-sensitive rebook RPCs can adopt it incrementally; the booking/tier gate is intentionally
-- left on now() for now (open/closed windows are already testable via relative seeding).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.app_now()
RETURNS timestamptz
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(NULLIF(current_setting('app.fake_now', true), '')::timestamptz, now());
$$;

GRANT EXECUTE ON FUNCTION public.app_now() TO PUBLIC;

-- Re-emit rebook_claims_needing_auto_reminder verbatim from 20260721100000, swapping the two
-- window comparisons now() → public.app_now() so the reminder's eligibility window is testable.
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
    AND s.priority_window_ends_at <= public.app_now() + make_interval(hours => GREATEST(1, LEAST(168, COALESCE(_lead_hours, 24))))
    AND COALESCE(NULLIF(pr.email, ''), NULLIF(gp.email, '')) IS NOT NULL
  ORDER BY c.id,
           COALESCE(spc.player_id::text, 'g:' || spc.guest_player_id::text),
           s.priority_window_ends_at ASC;
$$;

REVOKE ALL ON FUNCTION public.rebook_claims_needing_auto_reminder(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rebook_claims_needing_auto_reminder(int) TO service_role;
