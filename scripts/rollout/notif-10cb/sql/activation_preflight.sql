-- 10c-b RU3 — refuse to arm the cron unless the world is exactly as the runbook requires.
--
-- This runs BEFORE cron.alter_job(active := true) and is the last automated check between an
-- operator and a live digest send. Every assertion here is one that has a plausible failure mode
-- in a real rollout; none of them is decoration.
\set ON_ERROR_STOP on
\i ../../notif-10ca3/sql/_assert.sql

-- 1. the job must EXIST and still be INACTIVE. Arming an already-armed job is not idempotent
--    reassurance — it means someone else armed it, and the runbook's sequencing assumption
--    (switch on, canary reconciled, THEN arm) no longer holds.
SELECT pg_temp.assert((SELECT job_present FROM public.notif_digest_worker_liveness()),
  'the digest cron job exists');
SELECT pg_temp.assert(NOT (SELECT job_active FROM public.notif_digest_worker_liveness()),
  'the digest cron is still INACTIVE (if not, someone armed it out of band — stop)');

-- 2. exactly ONE event may be cut over, and it must be the one this release cut over.
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_event_types WHERE digest_cutover), 1,
  'exactly one event carries digest_cutover');
SELECT pg_temp.assert(
  (SELECT digest_cutover FROM public.notification_event_types WHERE key = 'open_slots_player'),
  'the cutover event is open_slots_player');

-- 3. the engine must ALREADY be enabled for it. Arming the cron first would schedule a worker
--    that finds nothing to do and reports healthy — a green light over an engine still off.
SELECT pg_temp.assert(
  (SELECT digest_engine_enabled FROM public.notification_event_types WHERE key = 'open_slots_player'),
  'the digest engine is enabled for open_slots_player (enable the switch BEFORE arming the cron)');

-- 4. and no OTHER event may have been enabled along the way.
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_event_types
    WHERE digest_engine_enabled AND key <> 'open_slots_player'), 0,
  'no event other than open_slots_player has the digest engine enabled');

-- 5. a canary must have actually RUN and SUCCEEDED. Arming on the strength of a canary that
--    errored — or that was never invoked at all — is the failure this whole sequence exists to
--    prevent, and "no news" reads identically to "it worked".
SELECT pg_temp.assert(
  (SELECT last_success_at IS NOT NULL FROM public.notif_digest_worker_liveness()),
  'a dispatch run has SUCCEEDED at least once (run the canary first)');

-- 6. nothing may be left in an uncertain state. A group awaiting evidence or mid-send is exactly
--    what a scheduler would multiply.
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_digest_groups
    WHERE state IN ('sending', 'awaiting_evidence', 'delivery_unknown')), 0,
  'no digest group is mid-send or awaiting evidence');

-- 7. no orphan provider event may be parked awaiting an operator. Quarantine means the
--    correlation is broken and a human has to decide; arming on top of that buries it.
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_orphan_reconcile_state WHERE quarantined), 0,
  'no orphan provider event is quarantined');
