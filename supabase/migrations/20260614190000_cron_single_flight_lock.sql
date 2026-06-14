-- Phase 4 (CRON-SF-03): session-scoped advisory-lock RPCs for cron single-flight.
--
-- The scheduled edge functions (process-onboarding-emails, invoice-health-check)
-- have no guard against an overlapping firing — a slow run spilling past the next
-- tick, a Vercel retry on timeout, or a manual call while cron is mid-run. Two
-- runs then do full duplicate work (duplicate queue SELECTs, duplicate profile
-- fetches/write-backs, thundering-herd claim RPCs; duplicate operator Slack
-- alerts for the read-only health check).
--
-- The existing advisory locks in the repo (20260614110000 slot capacity,
-- book_slot_for_payment, recalc_cycle_split_count) all use pg_advisory_XACT_lock
-- — TRANSACTION-scoped, which releases at the end of each PostgREST round-trip.
-- An edge function issues many separate PostgREST calls across one run, so an
-- xact lock cannot serialize the whole run. Hence a SESSION-scoped pair.
--
-- Best-effort single-flight: Supabase pools connections, so the lock may land on
-- a different backend than the function's subsequent queries — but it still
-- reliably makes a concurrent run's try_lock return false and bail, which IS the
-- single-flight semantics. The caller MUST release in a finally; the session
-- advisory lock also auto-releases when the pooled connection is recycled, so a
-- crashed run cannot wedge the job beyond one connection lifetime.
--
-- Key derived server-side via hashtextextended(<job name>, 0), matching the
-- keying convention in 20260614110000_slot_capacity_advisory_locks.sql.

CREATE OR REPLACE FUNCTION public.try_lock_cron_job(p_job_name text)
RETURNS boolean
LANGUAGE sql
AS $$ SELECT pg_try_advisory_lock(hashtextextended(p_job_name, 0)) $$;

CREATE OR REPLACE FUNCTION public.unlock_cron_job(p_job_name text)
RETURNS boolean
LANGUAGE sql
AS $$ SELECT pg_advisory_unlock(hashtextextended(p_job_name, 0)) $$;

COMMENT ON FUNCTION public.try_lock_cron_job(text) IS
  'Session-scoped single-flight guard for cron edge functions: pg_try_advisory_lock(hashtextextended(job_name,0)). Returns false if another run holds it — caller bails. Release with unlock_cron_job in a finally.';

REVOKE ALL ON FUNCTION public.try_lock_cron_job(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.unlock_cron_job(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.try_lock_cron_job(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.unlock_cron_job(text) TO service_role;
