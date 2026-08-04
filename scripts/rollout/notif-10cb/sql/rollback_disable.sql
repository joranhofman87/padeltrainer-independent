-- 10c-b RU3 — the two DATABASE halves of a rollback, in the order that matters.
--
-- WHY THIS IS A FILE AND NOT TWO `psql -c` STATEMENTS. Inline statements run in their own psql
-- process under the role/database search_path, so the other artifacts' path pins do not protect
-- them: `now()` is a function lookup and `=` is an operator lookup, and either can be shadowed by a
-- schema in that path. Every statement this bundle sends to production is now an enumerated artifact
-- that pins the path itself, and verify/enablement-selftest.sh fails if a `-c` reappears.
--
-- ORDER: the event flag FIRST (stop creating work), then the cron (stop draining). Either alone
-- still sends. The dispatcher additionally requires --switch-off-confirmed, because the third
-- switch — DIGEST_SEND_ENABLED on the edge function — is an env var no SQL here can read or set,
-- and a tick already in flight keeps sending the groups it has claimed until it finishes.
--
-- DELIBERATELY NOT ONE TRANSACTION. If disabling the engine succeeds and deactivating the cron
-- fails, a partial rollback is strictly better than none: work stops being created. Wrapping both in
-- a transaction would undo the half that worked. ON_ERROR_STOP makes the failure loud, and
-- rollback_verify.sql — run straight afterwards — refuses to call it done.
--
-- DEACTIVATE, never unschedule. Removing the job destroys the reviewed Vault-backed command, and
-- re-creating it by hand under time pressure is how a wrong endpoint or a missing bearer gets
-- introduced. (The guard for that rule is a plain text search over this directory, and it is
-- deliberately not taught about comments — so this note names the rule without naming the call, the
-- same way the bare-psql guard is kept strict by rewording rather than by weakening it.)
\set ON_ERROR_STOP on
SET search_path = pg_catalog;

UPDATE public.notification_event_types
   SET digest_engine_enabled = false, updated_at = pg_catalog.now()
 WHERE key OPERATOR(pg_catalog.=) 'open_slots_player';

SELECT cron.alter_job(jobid, active := false)
  FROM cron.job
 WHERE jobname OPERATOR(pg_catalog.=) 'notification-digest-worker'
   AND username OPERATOR(pg_catalog.=) current_user;
