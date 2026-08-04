-- 10c-b RU3 — prove the CANARY actually delivered. Takes :run_id, the id the invocation itself
-- returned (never a before/after snapshot).
--
-- Reconciling a run is not the same as passing it: reconcile_notification_digest_run succeeds for
-- any run that exists, whatever its phase, status or outcome. Without this, an EMPTY dispatch run
-- satisfies the gate and the first real provider send happens afterwards, under cron, to the whole
-- population — which is the one thing a canary exists to prevent.
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

SELECT pg_temp.assert(
  (SELECT count(*) = 1 FROM public.notification_worker_runs
    WHERE run_id = :'run_id'::uuid AND phase = 'dispatch' AND channel = 'email'),
  'the run id names exactly one dispatch/email run');

SELECT pg_temp.assert(
  (SELECT status = 'succeeded' FROM public.notification_worker_runs WHERE run_id = :'run_id'::uuid),
  'the canary run SUCCEEDED');

SELECT pg_temp.assert(
  (SELECT ended_at IS NOT NULL FROM public.notification_worker_runs WHERE run_id = :'run_id'::uuid),
  'the canary run has FINISHED (a still-running canary proves nothing yet)');

-- ...and it sent something the provider ACCEPTED. `worker_run_id` is the attempts table's own
-- column name (20261002100000), and `outcome_class = 'accepted'` is the narrowest honest evidence
-- that the whole path worked: a recorded attempt alone could be a terminal failure.
SELECT pg_temp.assert(
  (SELECT count(*) >= 1 FROM public.notification_digest_attempts a
    WHERE a.worker_run_id = :'run_id'::uuid
      AND a.recorded_at IS NOT NULL AND a.outcome_class = 'accepted'),
  'the canary recorded at least one ACCEPTED send attempt (an empty or failed run is not a canary)');

-- ...and a group it attempted must STILL be `sent`. An accepted attempt is a fact about the moment
-- the provider answered; it never changes afterwards. A bounce or suppression arriving right after
-- the run finished moves the group to `failed_terminal` while leaving the attempt accepted, the ids
-- correlated, the circuit closed and the orphan queue empty — so every other assertion here passes
-- and this script would print "verified to have delivered" over a canary that did not. Activation
-- asserts the same thing (_activation_assertions.sql) and would refuse the same evidence later;
-- the operator should not be told otherwise now.
SELECT pg_temp.assert(
  (SELECT count(*) >= 1 FROM public.notification_digest_groups g
    WHERE g.state = 'sent'
      AND EXISTS (SELECT 1 FROM public.notification_digest_attempts a
                   WHERE a.digest_group_id = g.id AND a.worker_run_id = :'run_id'::uuid)),
  'at least one group this canary attempted is STILL sent (an accepted attempt does not stay true if the group later failed)');

-- ...and `accepted` is NOT sufficient. record_notification_digest_result writes the attempt row as
-- accepted (20261004100000:1038) BEFORE it checks whether the group is already bound to a
-- DIFFERENT provider message (:1091); on a mismatch it manual-holds the channel and returns
-- 'correlation_mismatch'. The worker now reads that return and fails the run, so a mismatch DURING
-- the canary already surfaces as a failed run — but the attempt row still reads `accepted`.
--
-- A mismatch arriving by WEBHOOK after the run finished is different: resend-webhook-events.ts does
-- fire a best-effort alert for it, but it cannot change the status of a run that has already
-- completed, and a best-effort Slack call is not evidence an operator can rely on at a gate. These
-- assertions read the durable state instead, independently of the worker's accounting, at the point
-- where this script claims the canary "delivered".
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_digest_attempts a
     JOIN public.notification_digest_groups g ON g.id = a.digest_group_id
    WHERE a.worker_run_id = :'run_id'::uuid
      AND a.outcome_class = 'accepted'
      AND a.provider_message_id IS DISTINCT FROM g.provider_message_id), 0,
  'no accepted attempt disagrees with its group about the provider message id (correlation mismatch)');

SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_digest_group_attempts
    WHERE worker_run_id = :'run_id'::uuid AND action = 'global_config'), 0,
  'the canary recorded no global_config event (correlation mismatch, auth failure or quota exhaustion)');

-- EXACTLY ONE closed row, not "no non-closed rows". Counting only the bad states passes
-- VACUOUSLY when the row is absent — and absence is not a neutral state here:
-- begin_notification_digest_attempt ENSURES the row exists before it sends
-- (20261004100000, the INSERT ... ON CONFLICT DO NOTHING before the breaker gate), so a canary that
-- really sent guarantees one. Missing afterwards means the breaker state was lost or wiped, which
-- is exactly when a gate must fail closed rather than read silence as health.
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_provider_circuit
    WHERE channel = 'email' AND state = 'closed'), 1,
  'the email provider circuit exists and is CLOSED after the canary (a manual hold is state=open with retry_at NULL)');

-- ...and no provider event may be left UNRECONCILED against a group this canary sent. A tag/message
-- mismatch arriving by webhook takes the uncorrelated branch of apply_notification_provider_event
-- (20261006110000): it enrols an orphan with `quarantined = false` and leaves the group `sent` and
-- the circuit closed, so every assertion above passes over it. Without this, `canary` printed
-- "reconciled AND verified to have delivered" over exactly that state, and only the activation
-- preflight would have caught it — an operator verdict that was simply false.
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_orphan_reconcile_state o
    WHERE EXISTS (SELECT 1 FROM public.notification_digest_attempts a
                   WHERE a.digest_group_id = o.digest_group_id
                     AND a.worker_run_id = :'run_id'::uuid)), 0,
  'no provider event is still unreconciled against a group this canary sent');
