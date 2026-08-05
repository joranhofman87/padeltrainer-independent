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
-- WHAT MAKES THIS SAFE, stated correctly: DIGEST_SEND_ENABLED being off. That is the operator's
-- assertion and no SQL here can see it. What the assertions below add is a SNAPSHOT bound on the
-- damage a WRONG assertion could do — they remove the work that would otherwise be sent.
-- An earlier version claimed that "no event
-- has the digest engine enabled" made the invocation incapable of sending. THAT WAS FALSE, and the
-- code says why: `digest_engine_enabled` gates ENQUEUE ROUTING only. The worker never reads it —
-- materialize_notification_digest_groups selects any pending, ungrouped digest outbox row without
-- consulting the event catalog (20261005110000:62), and claim_notification_digest_group takes any
-- pending / request_ready / stale-locked group (20261004100000:474). A group or forming outbox row
-- left behind by an earlier attempt would therefore be SENT if the operator's switch assertion were
-- wrong.
--
-- So this asserts the thing that actually matters: at this instant there is NO WORK. The same
-- over-estimate the canary bounds itself with — every non-terminal email digest group plus every
-- ungrouped pending digest outbox row — must be exactly zero. That is a snapshot, not a guarantee:
-- what keeps this invocation from sending is DIGEST_SEND_ENABLED being off, which is the operator's
-- assertion. These checks remove the backlog that would make a wrong assertion catastrophic.
--
-- AND THE RESIDUAL, said plainly: that is a SNAPSHOT inside this transaction. pg_net dispatches after
-- COMMIT, so work enqueued in between is still reachable, and `DIGEST_SEND_ENABLED` remains the
-- operator's assertion rather than something SQL can see. A guarantee rather than a strong check
-- would need a no-dispatch mode the WORKER enforces; that belongs with the worker, not here, and is
-- recorded as such.
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

-- ...AND NOTHING IS ENABLED. This is a SEQUENCING prerequisite, not a no-send proof: the smoke
-- belongs at runbook step 2, before either switch, and an enabled engine means someone has already
-- moved past it. It does NOT make sending impossible — the worker claims existing groups whatever
-- the engine flags say, which is the whole reason the two zero-backlog assertions below exist.
-- Sending is prevented by DIGEST_SEND_ENABLED being off, which is `--switch-off-confirmed`: the
-- operator's word, and nothing here can check it.
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_event_types WHERE digest_engine_enabled), 0,
  'no event has the digest engine enabled (the smoke belongs BEFORE the switch, at runbook step 2)');

-- THE ONE THAT ACTUALLY BOUNDS THE SEND: no dispatchable work exists at all.
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_digest_groups
    WHERE channel = 'email' AND terminal_at IS NULL), 0,
  'no live email digest group exists (the worker claims groups regardless of the engine flag, so a leftover group WOULD be sent)');
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_outbox
    WHERE channel = 'email' AND delivery_mode = 'digest'
      AND digest_group_id IS NULL AND status = 'pending'), 0,
  'no ungrouped pending digest outbox row exists (materialization forms groups from these without consulting the event catalog)');

SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_worker_runs
    WHERE phase = 'dispatch' AND channel = 'email' AND ended_at IS NULL
      AND status IS DISTINCT FROM 'abandoned'), 0,
  'no dispatch run is in flight (its counters would move under the smoke and be read as the smoke''s)');

SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM net.http_request_queue
    WHERE url = 'https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/notification-digest-worker'), 0,
  'no request to the digest worker is already queued (another invocation is in progress — wait for it)');

-- N4 M1 (AC-6): durable in-flight record — see canary_invoke.sql for the full rationale. The
-- REPLAY-AWARE gate: a re-run carrying the same --invocation-request-id passes through to the
-- idempotent open() below; any OTHER unresolved invocation still refuses.
\i _invocation_gate_replay.sql
-- ...and PUBLISH its id into this transaction, which is what the reviewed command's body reads.
-- Transaction-local on purpose (round 6): a pg_cron execution runs in its OWN session and can
-- never see it, so a tick selected before this transaction and started after it still names
-- nothing. A database lookup could not give that guarantee — anything this transaction COMMITS is
-- something a late-starting tick can read too.
SELECT pg_catalog.set_config(
  'notif.dispatch_invocation',
  public.open_notification_worker_invocation('smoke', 'smoke_invoke.sql', :'invocation_request_id'::pg_catalog.uuid)::pg_catalog.text,
  true) AS invocation_id;

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

  IF md5(btrim(regexp_replace(v_cmd, '\s+', ' ', 'g'))) IS DISTINCT FROM '69204549e8cb81680e492e49ef08fdd6' THEN
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

-- N4 (AC-6): record WHICH request this invocation queued, in this same transaction — the
-- causal tie the disabled-smoke resolve demands. On a replay whose original commit was real,
-- this RAISES naming the original request id, rolling back (and thereby un-queueing) the
-- duplicate request the re-executed command just minted: a replay can never double-dispatch.
SELECT public.record_invocation_net_request(
  (SELECT id FROM public.notification_worker_invocations
    WHERE request_id = :'invocation_request_id'::pg_catalog.uuid),
  (SELECT request_id FROM pg_temp._smoke_request));

-- PRINTED BEFORE THE COMMIT, ON PURPOSE. If the connection drops after COMMIT but before the marker
-- below is emitted, psql exits non-zero over a request that IS committed and will be dispatched — and
-- the caller would otherwise report "rolled back, nothing was queued" and invite a retry that sends
-- twice. This provisional line means the caller can tell "nothing happened" from "something may
-- have"; it is deliberately a DIFFERENT marker, because at this point the transaction can still roll
-- back and the request would then never exist.
SELECT format('CANARY_REQUEST_PROVISIONAL=%s', request_id) AS canary_marker FROM pg_temp._smoke_request;

DROP TABLE pg_temp._gate_job;

COMMIT;

-- Same marker protocol as the canary: strict, and the caller requires exactly one match.
SELECT format('CANARY_REQUEST_ID=%s', request_id) AS canary_marker FROM pg_temp._smoke_request;

DROP TABLE pg_temp._smoke_request;
