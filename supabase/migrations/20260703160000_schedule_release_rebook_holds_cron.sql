-- Schedule the 5-minute "release-expired-rebook-holds" cron directly (companion to 20260703150000).
--
-- The public.schedule_release_rebook_holds_job() wrapper is admin-gated on auth.uid() and intended
-- for app-side invocation; a migration / the dashboard SQL editor runs as postgres (auth.uid() is
-- NULL) and can't satisfy that gate. The job itself is pure-SQL bookkeeping — cancel rebook holds
-- past their TTL and reset their priority claims to 'pending' — with NO service-role-key dependency,
-- so it is safe to schedule here as postgres (which owns pg_cron). Capacity already self-heals in
-- real time (the capacity predicate ignores holds where hold_expires_at <= now()); this cron is the
-- bookkeeping that frees the stale rows and lets the claim be re-offered.
--
-- Idempotent: unschedule any pre-existing job of the same name first, so a re-run is a no-op.
-- Guarded on pg_cron being installed so a stack without it (a fresh `db reset` / CI environment that
-- never reaches the cron bgworker) resets cleanly instead of erroring — the RETURN fires before any
-- cron.* reference is planned (plpgsql binds statements lazily), so the cron schema may be absent.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not installed — skipping release-expired-rebook-holds schedule';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'release-expired-rebook-holds') THEN
    PERFORM cron.unschedule('release-expired-rebook-holds');
  END IF;

  PERFORM cron.schedule(
    'release-expired-rebook-holds',
    '*/5 * * * *',
    'SELECT public.release_expired_rebook_holds()'
  );
END $$;
