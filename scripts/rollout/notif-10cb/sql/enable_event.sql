-- N7 — STAGED ACTIVATION: turn the digest engine on for ONE MORE event, after the first one has
-- been running.
--
-- `enable_engine.sql` is the FIRST stage: it opens the delivery path and enables the cutover event
-- while the cron is still inactive. This file is every stage after that, and its preconditions are
-- the opposite ones: the path is already open, the cron is ARMED, and the system is healthy right
-- now. Staging exists so that a bad event costs one event's worth of mail rather than the whole
-- catalogue's, so the health checks are not ceremony — they are the reason to stage at all.
--
-- Takes :event_key. Enabling an event on an OPEN path is safe by construction: the boundary
-- already excludes everything that happened before it, so a newly-enabled event can only ever
-- digest events that happen from here on.
\set ON_ERROR_STOP on
SET search_path = pg_catalog;

\i ../../notif-10ca3/sql/_assert.sql

-- ── the blast radius, printed BEFORE anything changes ───────────────────────────────────────
-- Recent volume, not a prediction: how much this event has produced lately is the honest proxy
-- for how much it will produce next. (A true would-send count is the admin surface's recipient
-- preview, which is admin-gated and therefore not reachable from psql.)
SELECT 'stage' AS scope, :'event_key' AS name,
       count(*)::text AS value,
       'outbox rows for this event in the last 7 days — the volume this stage will start digesting' AS detail
  FROM public.notification_outbox
 WHERE event_type = :'event_key'
   AND created_at OPERATOR(pg_catalog.>=) (pg_catalog.now() OPERATOR(pg_catalog.-) pg_catalog.make_interval(days => 7));

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- the same row lock the first stage takes, and the same identity assertions — with the ARMED
-- expectation, because by now the cron is running
\i _job_identity_assertions_armed.sql
LOCK TABLE public.notification_event_types IN SHARE ROW EXCLUSIVE MODE;

-- ── the path must already be OPEN. A stage is not an activation. ────────────────────────────
SELECT pg_temp.assert(
  (SELECT state OPERATOR(pg_catalog.=) 'active' AND boundary_at IS NOT NULL
     FROM public.notification_activation_boundaries WHERE path = 'email:digest'),
  'the email:digest path is already OPEN (a stage adds an event to a running path; opening the path is enable-engine''s job, once)');

-- ── and the system must be healthy RIGHT NOW, or this is the wrong moment to add load ───────
SELECT pg_temp.assert_eq(
  (SELECT count(*)::pg_catalog.int4 FROM public.notification_channel_kill_switches), 0,
  'no channel is killed');
SELECT pg_temp.assert_eq(
  (SELECT count(*)::pg_catalog.int4 FROM public.notification_provider_circuit WHERE state OPERATOR(pg_catalog.<>) 'closed'), 0,
  'every provider circuit is CLOSED');
SELECT pg_temp.assert_eq(
  (SELECT count(*)::pg_catalog.int4 FROM public.notification_orphan_reconcile_state WHERE quarantined), 0,
  'no orphan provider event is quarantined');
SELECT pg_temp.assert(
  (SELECT l.seconds_since_success IS NOT NULL AND l.seconds_since_success OPERATOR(pg_catalog.<) 3600
     FROM public.notif_digest_worker_liveness() l),
  'the worker has SUCCEEDED within the last hour (staging onto a pipeline that is not currently working adds load to a problem)');
SELECT pg_temp.assert_eq(
  (SELECT count(*)::pg_catalog.int4 FROM public.notification_digest_groups
    WHERE terminal_at IS NULL AND uncertain_since IS NOT NULL), 0,
  'no group is currently uncertain (finish resolving the last stage before starting the next)');

-- ── the event itself ────────────────────────────────────────────────────────────────────────
SELECT pg_temp.assert(
  (SELECT digest_cutover FROM public.notification_event_types WHERE key = :'event_key'),
  'the event exists and is a digest_cutover event (an event that never opted into digesting must not be staged into it)');
SELECT pg_temp.assert(
  (SELECT NOT digest_engine_enabled FROM public.notification_event_types WHERE key = :'event_key'),
  'the event is not already enabled (zero rows changed means the world is not what you think — re-read status)');

WITH u AS (
  UPDATE public.notification_event_types
     SET digest_engine_enabled = true, updated_at = pg_catalog.now()
   WHERE key = :'event_key' AND NOT digest_engine_enabled
  RETURNING 1
)
SELECT pg_temp.assert_eq((SELECT count(*)::pg_catalog.int4 FROM u), 1,
  'exactly one event row was enabled');

-- the postcondition, and the resulting stage set — printed so the transcript records exactly
-- which events are live after this stage
SELECT pg_temp.assert(
  (SELECT digest_engine_enabled FROM public.notification_event_types WHERE key = :'event_key'),
  'the digest engine is now enabled for this event');

COMMIT;

SELECT 'stage' AS scope, 'enabled_events' AS name, count(*)::text AS value,
       string_agg(key, ', ' ORDER BY key) AS detail
  FROM public.notification_event_types WHERE digest_engine_enabled;

SELECT pg_catalog.format('STAGE_ENABLED=%s', :'event_key') AS stage_marker;
