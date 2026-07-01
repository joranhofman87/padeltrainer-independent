-- Automatic expiry of lapsed rebook priority claims (companion to the release/visibility logic).
--
-- WHY: a slot's tier (priority → members → public) already advances by timestamp on read
-- (resolveSlotTier), and slotVisibility.computeReleasedSlotIds frees a slot ONLY when no claim on it
-- is still 'pending' or 'claimed' (i.e. EVERYONE declined) — the owner's rule: a single "No" never
-- opens an individual seat; the rebooking group arranges its own replacements, and the cycle only
-- opens up when nobody rebooks. BUT a non-responder who never clicks Yes/No keeps their claim
-- 'pending' forever (expiry is only evaluated on the fly when a player accepts/declines). So a cycle
-- that everybody effectively abandoned (some declined, the rest silent) never reaches "0 pending"
-- and never releases.
--
-- FIX: once a slot's PRIORITY window has lapsed, mark its still-'pending' claims 'expired' (a freed
-- state, like 'declined'). This is per-CLAIM bookkeeping, but it never opens an individual seat — the
-- slot only becomes bookable by the next tier once ALL its claims are non-pending/non-claimed, exactly
-- as computeReleasedSlotIds already computes. A slot with any 'claimed' player (someone rebooked) is
-- left untouched, so the rebooking captain keeps the slot and swaps players themselves.

CREATE OR REPLACE FUNCTION public.expire_lapsed_priority_claims()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  WITH lapsed AS (
    UPDATE public.slot_priority_claims c
      SET status = 'expired',
          responded_at = COALESCE(c.responded_at, now())
    FROM public.availability_slots s
    WHERE c.slot_id = s.id
      AND c.status = 'pending'
      AND s.priority_window_ends_at IS NOT NULL
      AND s.priority_window_ends_at < now()
    RETURNING c.id
  )
  SELECT count(*) INTO v_count FROM lapsed;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.expire_lapsed_priority_claims() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expire_lapsed_priority_claims() TO service_role;

-- Schedule the expiry every 15 minutes. Mirrors 20260703160000: postgres owns pg_cron; the job is
-- pure-SQL bookkeeping (no service-role key), so it is safe to schedule from a migration.
-- Idempotent + guarded on pg_cron being installed (a fresh `db reset` / CI without the cron bgworker
-- resets cleanly instead of erroring — the RETURN fires before any cron.* reference is planned).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not installed — skipping expire-lapsed-priority-claims schedule';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'expire-lapsed-priority-claims') THEN
    PERFORM cron.unschedule('expire-lapsed-priority-claims');
  END IF;

  PERFORM cron.schedule(
    'expire-lapsed-priority-claims',
    '*/15 * * * *',
    'SELECT public.expire_lapsed_priority_claims()'
  );
END $$;
