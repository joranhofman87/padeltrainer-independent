-- 10c-b — PROVE THE WORLD IS STILL INERT, before any switch is enabled.
--
-- Runs at step 1b, ahead of DIGEST_SEND_ENABLED and ahead of digest_engine_enabled. It asserts the
-- cron job present is EXACTLY the reviewed one and is INACTIVE — the two facts that decide whether
-- turning the engine on is safe. `status` prints those; printing is not a gate, and the whole point
-- is to fail closed before the irreversible step rather than to be read carefully afterwards.
\set ON_ERROR_STOP on
\i ../../notif-10ca3/sql/_assert.sql

DROP TABLE IF EXISTS pg_temp._gate_job;
CREATE TEMP TABLE _gate_job AS
  SELECT jobid FROM cron.job
   WHERE jobname = 'notification-digest-worker' AND username = current_user;

\i _job_identity_assertions.sql

-- ...and nothing may be enabled yet. Enabling the engine while an armed job exists is the exact
-- sequence this step exists to prevent.
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_event_types WHERE digest_engine_enabled), 0,
  'no event has the digest engine enabled yet (this check belongs BEFORE the switch, not after)');

DROP TABLE pg_temp._gate_job;
SELECT pg_temp.note('INERT confirmed: the reviewed job is present, INACTIVE, and no engine is enabled.');
