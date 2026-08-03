-- 10c-b RU3 — prove the CANARY actually delivered. Takes :run_id, the id the invocation itself
-- returned (never a before/after snapshot).
--
-- Reconciling a run is not the same as passing it: reconcile_notification_digest_run succeeds for
-- any run that exists, whatever its phase, status or outcome. Without this, an EMPTY dispatch run
-- satisfies the gate and the first real provider send happens afterwards, under cron, to the whole
-- population — which is the one thing a canary exists to prevent.
\set ON_ERROR_STOP on
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

-- ...and `accepted` is NOT sufficient. record_notification_digest_result writes the attempt row as
-- accepted (20261004100000:1038) BEFORE it checks whether the group is already bound to a
-- DIFFERENT provider message (:1091); on a mismatch it manual-holds the channel and returns
-- 'correlation_mismatch'. The worker now reads that return and fails the run, so a mismatch DURING
-- the canary already surfaces as a failed run — but the attempt row still reads `accepted`, and a
-- mismatch arriving by WEBHOOK after the run finished is reported by nothing at all. So it is
-- checked here too, independently of the worker's own accounting, at the point where this script
-- claims the canary "delivered".
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

SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_provider_circuit
    WHERE channel = 'email' AND state <> 'closed'), 0,
  'the email provider circuit is CLOSED after the canary (a manual hold is state=open with retry_at NULL)');
