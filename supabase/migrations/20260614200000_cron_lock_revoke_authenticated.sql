-- Lock the cron single-flight RPCs down to service_role ONLY.
--
-- 20260614190000 revoked EXECUTE only FROM PUBLIC. But Supabase ships default
-- privileges that GRANT EXECUTE to anon + authenticated on every newly created
-- public function, and those default grants are NOT removed by a REVOKE ...
-- FROM PUBLIC — so try_lock_cron_job / unlock_cron_job remained callable by any
-- logged-in user (verified live: an authenticated session got try_lock = true).
--
-- These are server-to-server cron primitives. A non-service-role caller that can
-- take or release a job's advisory lock could interfere with the cron's
-- single-flight (grab the lock, or release one a legitimate run holds). Revoke
-- from anon + authenticated explicitly; only service_role (the cron's key) may
-- execute them.

REVOKE ALL ON FUNCTION public.try_lock_cron_job(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.unlock_cron_job(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.try_lock_cron_job(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.unlock_cron_job(text) TO service_role;
