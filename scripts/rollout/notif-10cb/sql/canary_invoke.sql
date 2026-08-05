-- 10c-b RU2 — INVOKE THE CANARY, through the same guards as everything else in this bundle.
--
-- WHY THIS EXISTS. Runbook step 4 used to read "(owner) invoke the worker ONCE by hand". That is the
-- one step in the whole sequence that actually sends mail, and it was the only step performed with
-- no tooling at all: a hand-written statement against production, outside EXPECTED_REF, outside the
-- hostile-PG*-environment stripping, with nothing re-checking that the job is still the reviewed one
-- and still inactive. `assert-inert` runs at step 1b — four steps and two switches earlier — so by
-- step 4 its result is stale, and a job armed in between would already be ticking.
--
-- WHAT IT EXECUTES, AND WHY IT IS NOT WRITTEN DOWN HERE. It runs the cron job's OWN stored command,
-- after asserting that command hashes to the reviewed value under a row lock. So the thing invoked
-- is by construction the thing that was reviewed, and the thing a tick would run — not a
-- hand-transcribed lookalike that could name a different endpoint. Writing the command out here
-- would also put a net.http_post + Authorization + Vault-read triple into a checked-in .sql, which
-- is precisely the signature scripts/check-legacy-service-role-consumers.mjs exists to hunt for.
--
-- WHAT IT DOES NOT DO. It does not arm the cron, enable an engine, or set the edge kill switch. If
-- DIGEST_SEND_ENABLED is off the worker answers 200 {"status":"disabled","reason":"disabled"} and
-- nothing is sent — which is why there is no --switch-on-confirmed flag: the failure direction is
-- safe, and the surfaced response says so plainly rather than a flag asserting it blind.
--
-- pg_net is ASYNCHRONOUS. net.http_post enqueues and returns a request id; the request leaves only
-- after this transaction COMMITS, and the reply lands in net._http_response later. So this artifact
-- prints the request id and canary_invoke_response.sql reads the reply — the invocation and the
-- response cannot be one transaction, and pretending otherwise would mean printing a result that
-- had not happened yet.
--
-- Takes :max_recipients — the operator's ceiling on how many recipients this invocation may reach.
\set ON_ERROR_STOP on
-- NAME RESOLUTION IS PINNED FOR THE WHOLE SESSION, before any include and before any statement.
--
-- Every unqualified function, operator, aggregate, cast and relation in this file — and in the
-- shared includes it pulls in — is resolved through search_path, which is settable per role and per
-- database and which the client-side PG* stripping cannot reach. Ordering the path is NOT a defence:
-- function resolution prefers an exact-arity, exact-type candidate over pg_catalog's VARIADIC "any"
-- wherever that schema sits, even after an explicit pg_catalog. A hostile `count(text)` reports zero;
-- a hostile `md5(text)` matches any command; a hostile `=` ignores a queued canary. Only EXCLUDING
-- such a schema works, so every artifact in this directory pins the path and
-- src/test/notif10cbActivationPreflight.test.ts fails if one stops.
--
-- SESSION-WIDE, not SET LOCAL: a transaction-scoped setting is reverted by COMMIT, and these files
-- keep asserting and reporting afterwards. pg_temp is deliberately absent — it is never searched for
-- functions or operators, and every temp object here is written as pg_temp.x.
SET search_path = pg_catalog;

\i ../../notif-10ca3/sql/_assert.sql

-- Temp tables are SESSION-scoped, not transaction-scoped. A previous run that died between COMMIT
-- and its own cleanup would otherwise make the next one fail on "relation already exists" — a
-- confusing refusal that says nothing about the world it was asked to check.
DROP TABLE IF EXISTS pg_temp._gate_job;
DROP TABLE IF EXISTS pg_temp._canary_radius;
DROP TABLE IF EXISTS pg_temp._canary_request;

BEGIN;

-- Bounded before any lock is taken, exactly as in activate.sql. This transaction holds a table lock
-- on the run ledger and a row lock on the cron job, so an unbounded wait would stall every
-- worker-run write behind an owner-driven step that is always safe to re-run.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- (search_path is pinned at the TOP of this file, session-wide. It was briefly a SET LOCAL here, and
-- that was wrong twice over: a transaction-scoped setting is reverted by COMMIT, so the marker this
-- file prints afterwards — the request id the whole subcommand turns on — was computed with an
-- unqualified `format` under whatever path the session had. One mechanism, applied once, at the top.)
--
-- LOCK ORDER, deliberately the same across this bundle so two artifacts can never deadlock:
--   notification_worker_runs  →  cron.job  →  notification_event_types
-- (activate.sql takes the first two then group rows; enable_engine.sql takes the last two.)
--
-- 1. FREEZE THE RUN LEDGER. "No dispatch run is in flight" is a predicate, and without this lock
--    another invocation can start one immediately after it is evaluated — so the canary would race
--    a run it never saw, and the run id printed below would not be the only thing that happened.
--    SHARE conflicts with the ROW EXCLUSIVE an INSERT takes, and it is released at COMMIT, which is
--    also when pg_net first dispatches — so the worker this invocation triggers is never blocked.
LOCK TABLE public.notification_worker_runs IN SHARE MODE;

-- 2. LOCK THE JOB ROW AND KEEP IT. Materialised once: under READ COMMITTED every statement takes a
--    fresh snapshot, so a job that was ABSENT locked nothing and a later name-based read could pick
--    up one another session inserted in between. Every assertion, and the command executed at the
--    end, refer to this one row.
CREATE TEMP TABLE _gate_job AS
  SELECT jobid FROM cron.job
   WHERE jobname = 'notification-digest-worker' AND username = current_user
     FOR UPDATE;

-- 3. ...and the event catalog, so "this event on, nothing else" is a transactional fact rather than
--    a snapshot someone can invalidate before the request leaves. Same mode as enable_engine.sql.
LOCK TABLE public.notification_event_types IN SHARE ROW EXCLUSIVE MODE;

-- THE JOB IS THE REVIEWED JOB, AND IT IS STILL INACTIVE — the full shared check, not a weaker local
-- copy. Inactivity matters twice over here: an armed job means the cron is already dispatching to
-- the whole population, so "one controlled canary" is a fiction and the operator must stop; and the
-- command hash is what makes executing the stored text below safe at all.
\i _job_identity_assertions.sql

-- THE ENGINE MUST ALREADY BE ON for the cutover event (runbook step 3b). Invoking with it off
-- produces an empty dispatch run: a 200, a `succeeded` status and nothing sent. That is the state a
-- canary exists to distinguish from a working one, and an operator reading "succeeded" would have
-- every reason to think the path was proven.
SELECT pg_temp.assert(
  (SELECT digest_engine_enabled FROM public.notification_event_types WHERE key = 'open_slots_player'),
  'the digest engine is ENABLED for open_slots_player (run enable-engine first — invoking with it off yields an empty run that proves nothing)');
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_event_types
    WHERE digest_engine_enabled AND key <> 'open_slots_player'), 0,
  'no event other than the cutover event has the digest engine enabled');

-- NOTHING IN FLIGHT. A second dispatch run overlapping this one would make the returned run id an
-- incomplete account of what this invocation caused, and `canary` verifies exactly one run id.
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_worker_runs
    WHERE phase = 'dispatch' AND channel = 'email' AND ended_at IS NULL
      AND status IS DISTINCT FROM 'abandoned'), 0,
  'no dispatch run is in flight (wait for it to finish before invoking a canary)');

-- ...AND NOTHING ALREADY QUEUED FOR THE WORKER. A run row only appears once the worker starts, so
-- between another invocation's COMMIT and that moment there is nothing in notification_worker_runs to
-- see, and the check above reads clean over a canary that is already on its way.
--
-- STATED PRECISELY: this queue check NARROWS the window (pg_net owns the queue row's lifetime,
-- so a dispatched-but-not-yet-running request is invisible here); the DURABLE closure is the
-- invocation record gated + opened just below (N4 M1, Stage-3.5 AC-6) — the record exists from
-- this transaction's commit until the reconcile resolves it, so nothing can read "idle" over a
-- travelling canary again.
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM net.http_request_queue
    WHERE url = 'https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/notification-digest-worker'), 0,
  'no request to the digest worker is already queued (another canary invocation is in progress — wait for it to answer)');

-- N4 M1 (AC-6): the DURABLE half of the same guarantee, then OPEN this invocation's record in
-- THIS transaction — it exists from the instant the request can. :invocation_request_id is
-- generated once per operator command by run-enablement.sh, so an ambiguous-commit retry
-- recovers the SAME invocation instead of stacking a second.
\i _invocation_gate.sql
SELECT public.open_notification_worker_invocation('canary', 'canary_invoke.sql', :'invocation_request_id'::pg_catalog.uuid) AS invocation_id;

-- THE BLAST RADIUS. "Canary: one recipient" was a hope, not a fact: the worker sends to every group
-- it can claim, plus everything materialization forms during the same run. If the engine has been on
-- for a while, or a backfill left work behind, this invocation reaches all of it.
--
-- WHAT THIS BOUNDS, EXACTLY: the live digest work VISIBLE IN THIS TRANSACTION. It is an over-estimate
-- of that, in the fail-closed direction:
--   * every NON-TERMINAL email digest group — `terminal_at IS NULL` is exactly "not terminal",
--     because the schema-owned guard trigger stamps and clears that column itself
--     (20261002100000, notification_digest_groups_guard). A state-name list copied into this file
--     would drift the first time one is added; this cannot. Splits are covered too: a chunk group is
--     a group, so a split recipient is counted more than once, never less.
--   * every ungrouped pending digest outbox row — the same predicate as idx_outbox_digest_forming.
--     Many of these collapse into ONE group per recipient, so counting rows overshoots recipients.
--
-- WHAT IT DOES NOT BOUND, and the first version of this comment wrongly implied it did: work
-- committed AFTER this snapshot. pg_net dispatches once this transaction commits and the worker
-- materializes whatever is pending when it runs, so a row enqueued in between is sent by this same
-- invocation and was never counted here. That is not closable from inside this transaction — locking
-- the outbox would stall live enqueues and still release at COMMIT. It is instead caught AFTER the
-- fact by canary_scope_verify.sql, which counts the recipients the finished run actually reached and
-- refuses to let the rollout continue on a canary that was not one.
CREATE TEMP TABLE _canary_radius AS
  SELECT (SELECT count(*)::int FROM public.notification_digest_groups
           WHERE channel = 'email' AND terminal_at IS NULL) AS non_terminal_groups,
         (SELECT count(*)::int FROM public.notification_outbox
           WHERE channel = 'email' AND delivery_mode = 'digest'
             AND digest_group_id IS NULL AND status = 'pending') AS forming_members;

SELECT pg_temp.assert(
  (SELECT non_terminal_groups + forming_members <= :'max_recipients'::int FROM pg_temp._canary_radius),
  (SELECT format(
     'the canary can reach at most %s recipient(s), within the ceiling of %s (%s non-terminal email digest group(s) + %s ungrouped pending digest outbox row(s); an over-estimate, since outbox rows collapse into one group per recipient)',
     non_terminal_groups + forming_members, :'max_recipients'::int, non_terminal_groups, forming_members)
   FROM pg_temp._canary_radius));

-- ===========================================================================
-- THE INVOCATION. Read the stored command from the LOCKED row and execute it.
--
-- The hash is re-asserted inside the statement that reads the text being executed. Under the row
-- lock it cannot have changed since _job_identity_assertions.sql hashed it, so this is not closing a
-- race — it is making the file independently safe. Losing or reordering the include above would
-- otherwise turn this into "execute whatever is in cron.job", which is the single most dangerous
-- statement in this bundle.
--
-- SAID PLAINLY, BECAUSE THE TESTS CANNOT SAY IT: this check is SUBSUMED by the include while the
-- include is there, so no behavioural test can distinguish its presence from its absence — deleting
-- it leaves the whole realpg suite green. It is pinned STRUCTURALLY instead, by
-- src/test/notif10cbActivationPreflight.test.ts, which also requires every 32-hex literal in this
-- directory to equal the hash of the command the F migration actually schedules. The include itself
-- IS behaviourally pinned (remove it and the armed-cron and drifted-command scenarios both fail).
CREATE TEMP TABLE _canary_request (request_id bigint);

DO $do$
DECLARE v_cmd text; v_req bigint;
BEGIN
  SELECT command INTO STRICT v_cmd FROM cron.job
   WHERE jobid = (SELECT jobid FROM pg_temp._gate_job);

  IF md5(btrim(regexp_replace(v_cmd, '\s+', ' ', 'g'))) IS DISTINCT FROM '657295911df940d4aecc69a87169574c' THEN
    RAISE EXCEPTION 'ASSERT FAILED: refusing to execute a cron command that is not EXACTLY the reviewed one';
  END IF;

  -- The reviewed command is a single SELECT returning pg_net's request id.
  EXECUTE v_cmd INTO v_req;

  IF v_req IS NULL THEN
    RAISE EXCEPTION 'ASSERT FAILED: the invocation returned no pg_net request id — nothing was queued';
  END IF;

  INSERT INTO pg_temp._canary_request (request_id) VALUES (v_req);
  RAISE NOTICE 'ok: the reviewed command was executed and queued pg_net request %', v_req;
END $do$;

SELECT pg_temp.assert_eq((SELECT count(*)::int FROM pg_temp._canary_request), 1,
  'exactly one pg_net request was queued');

-- PRINTED BEFORE THE COMMIT, ON PURPOSE. If the connection drops after COMMIT but before the marker
-- below is emitted, psql exits non-zero over a request that IS committed and will be dispatched — and
-- the caller would otherwise report "rolled back, nothing was queued" and invite a retry that sends
-- twice. This provisional line means the caller can tell "nothing happened" from "something may
-- have"; it is deliberately a DIFFERENT marker, because at this point the transaction can still roll
-- back and the request would then never exist.
SELECT format('CANARY_REQUEST_PROVISIONAL=%s', request_id) AS canary_marker FROM pg_temp._canary_request;

DROP TABLE pg_temp._gate_job;
DROP TABLE pg_temp._canary_radius;

COMMIT;

-- Printed AFTER the commit, because that is when the request actually becomes real: pg_net dispatches
-- on commit, so a request id printed from inside the transaction could still be rolled back.
-- The marker is machine-read by run-enablement.sh, which requires EXACTLY one match of the strict
-- form below — the inventory-parse lesson from slice H: a loosely-parsed record is a forgeable one.
SELECT format('CANARY_REQUEST_ID=%s', request_id) AS canary_marker FROM pg_temp._canary_request;

DROP TABLE pg_temp._canary_request;
