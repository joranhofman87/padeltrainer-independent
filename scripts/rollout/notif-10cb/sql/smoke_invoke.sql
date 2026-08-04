-- 10c-b RU2 — INVOKE THE WORKER WHILE THE SWITCH IS OFF, through the same guards as everything else.
--
-- WHY THIS EXISTS. Runbook step 2 said "capture the counters either side of the disabled
-- invocation", and left the invocation itself to the operator — whose documented procedure was a raw
-- `net.http_post` in docs/CRON_SERVICE_KEY_SETUP.md with a HAND-SUBSTITUTED `<project-ref>` and
-- unqualified `jsonb_build_object`, `||`, `=` and `::jsonb`. `DIGEST_SEND_ENABLED=false` stops the
-- mail; it does nothing whatever for the credential. That statement posts a Vault-decrypted
-- service_role bearer, so a mistyped ref sends it to another project and a hostile
-- `public.jsonb_build_object(text,text,text,text)` captures it — exactly the exposure the canary path
-- was rebuilt to close, still open on the step BEFORE it.
--
-- So the smoke now runs the job's OWN stored command, hash-pinned under a row lock, exactly as
-- `canary_invoke.sql` does. Same reasoning, same protections, and the endpoint comes from the
-- reviewed job rather than from a runbook the operator retypes.
--
-- WHAT MAKES THIS THE *DISABLED* SMOKE, and not a send: it refuses unless the world is still inert.
-- The cron is inactive AND no event has the digest engine enabled, so there is no digest work to
-- materialize and nothing to dispatch even if the edge switch were wrong. That is a stronger
-- guarantee than the flag the operator asserts, and it is checked rather than assumed.
\set ON_ERROR_STOP on
-- NAME RESOLUTION IS PINNED FOR THE WHOLE SESSION, before any include and before any statement.
-- See canary_invoke.sql for the reasoning; the short version is that ordering search_path is not a
-- defence, because resolution prefers an exact-arity candidate over pg_catalog's VARIADIC "any"
-- wherever that schema sits. Only excluding it works.
SET search_path = pg_catalog;

\i ../../notif-10ca3/sql/_assert.sql

DROP TABLE IF EXISTS pg_temp._gate_job;
DROP TABLE IF EXISTS pg_temp._smoke_request;

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Same lock order as the rest of the bundle: worker_runs → cron.job → event catalog.
LOCK TABLE public.notification_worker_runs IN SHARE MODE;

CREATE TEMP TABLE _gate_job AS
  SELECT jobid FROM cron.job
   WHERE jobname = 'notification-digest-worker' AND username = current_user
     FOR UPDATE;

LOCK TABLE public.notification_event_types IN SHARE ROW EXCLUSIVE MODE;

-- The job is the reviewed one and is still INACTIVE — the same shared gate, not a weaker local copy.
\i _job_identity_assertions.sql

-- ...AND NOTHING IS ENABLED. This is what makes the smoke provably incapable of sending: with every
-- engine off, the resolver creates no digest work, so a dispatch run has nothing to claim regardless
-- of what the edge switch says. `--switch-off-confirmed` is the operator's word for the env var;
-- this is the database's own proof, and it is the stronger of the two.
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_event_types WHERE digest_engine_enabled), 0,
  'no event has the digest engine enabled (a disabled smoke must be unable to send, not merely expected not to)');

SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_worker_runs
    WHERE phase = 'dispatch' AND channel = 'email' AND ended_at IS NULL
      AND status IS DISTINCT FROM 'abandoned'), 0,
  'no dispatch run is in flight (its counters would move under the smoke and be read as the smoke''s)');

SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM net.http_request_queue
    WHERE url = 'https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/notification-digest-worker'), 0,
  'no request to the digest worker is already queued (another invocation is in progress — wait for it)');

-- ===========================================================================
-- Execute the reviewed command. The hash is re-asserted in the same statement that reads the text,
-- for the reason canary_invoke.sql sets out: losing the include above would otherwise turn this into
-- "execute whatever is in cron.job". Pinned structurally by
-- src/test/notif10cbActivationPreflight.test.ts.
CREATE TEMP TABLE _smoke_request (request_id bigint);

DO $do$
DECLARE v_cmd text; v_req bigint;
BEGIN
  SELECT command INTO STRICT v_cmd FROM cron.job
   WHERE jobid = (SELECT jobid FROM pg_temp._gate_job);

  IF md5(btrim(regexp_replace(v_cmd, '\s+', ' ', 'g'))) IS DISTINCT FROM '657295911df940d4aecc69a87169574c' THEN
    RAISE EXCEPTION 'ASSERT FAILED: refusing to execute a cron command that is not EXACTLY the reviewed one';
  END IF;

  EXECUTE v_cmd INTO v_req;

  IF v_req IS NULL THEN
    RAISE EXCEPTION 'ASSERT FAILED: the invocation returned no pg_net request id — nothing was queued';
  END IF;

  INSERT INTO pg_temp._smoke_request (request_id) VALUES (v_req);
  RAISE NOTICE 'ok: the reviewed command was executed and queued pg_net request %', v_req;
END $do$;

SELECT pg_temp.assert_eq((SELECT count(*)::int FROM pg_temp._smoke_request), 1,
  'exactly one pg_net request was queued');

DROP TABLE pg_temp._gate_job;

COMMIT;

-- Same marker protocol as the canary: strict, and the caller requires exactly one match.
SELECT format('CANARY_REQUEST_ID=%s', request_id) AS canary_marker FROM pg_temp._smoke_request;

DROP TABLE pg_temp._smoke_request;
