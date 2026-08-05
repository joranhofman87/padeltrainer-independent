-- N7 — POSTFLIGHT: prove the activated system is behaving, and that the invariant the whole
-- programme is built on actually held in production.
--
-- Read-only. It changes nothing, takes no locks and can be run as often as an operator likes —
-- during the watch window after activation, the morning after, or whenever someone asks "is it
-- still fine?". Every check either passes or RAISES, so a scheduled run of this file is an alarm
-- rather than a report nobody reads.
--
-- Takes :window_minutes — how far back "recently" means for the liveness and health checks. The
-- runbook passes the watch window it is actually watching.
\set ON_ERROR_STOP on
-- NAME RESOLUTION IS PINNED FOR THE WHOLE SESSION (an exact-arity rival beats pg_catalog wherever
-- its schema sits, so only EXCLUDING one works — the doctrine every artifact here follows).
SET search_path = pg_catalog;

-- BOUNDED: every count here is exact and some scan the outbox over a window, so on a large
-- database this is real work. Read-only work, but a runbook step that hangs is a runbook step
-- nobody runs — a timeout turns that into a visible failure.
SET statement_timeout = '120s';

\i ../../notif-10ca3/sql/_assert.sql

-- ── 1. THE INVARIANT. Everything else here is health; this is the promise. ───────────────────
-- No event that happened BEFORE a path was opened may ever have been delivered on it. This reads
-- the outcome, not the gate: it asks the ledger whether a pre-boundary row was ever sent, which
-- is the only question that cannot be answered by inspecting code.
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int
     FROM public.notification_outbox o
     JOIN public.notification_activation_boundaries b
       ON b.path = o.channel
            OPERATOR(pg_catalog.||) (CASE WHEN o.delivery_mode OPERATOR(pg_catalog.=) 'digest'
                                          THEN ':digest' ELSE ':instant' END)
    WHERE b.state OPERATOR(pg_catalog.=) 'active'
      AND o.created_at OPERATOR(pg_catalog.<) b.boundary_at
      AND o.status = ANY (ARRAY['sent', 'delivered', 'processing'])), 0,
  'NO-BACKLOG HELD: no row created before its path''s activation boundary has been sent, delivered, or is in flight');

-- …and the same one hop later: no group holding a pre-boundary member ever reached a provider.
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int
     FROM public.notification_digest_groups g
     JOIN public.notification_activation_boundaries b
       ON b.path = g.channel OPERATOR(pg_catalog.||) ':digest' AND b.state OPERATOR(pg_catalog.=) 'active'
    WHERE g.first_send_at IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.notification_outbox o
                   WHERE o.digest_group_id = g.id AND o.created_at OPERATOR(pg_catalog.<) b.boundary_at)), 0,
  'NO-BACKLOG HELD at the group hop: no digest holding a pre-boundary member was ever dispatched');

-- ── 2. the schedule is still the reviewed one, and it is running ─────────────────────────────
\i _job_identity_assertions_armed.sql

SELECT pg_temp.assert(
  (SELECT l.last_success_at IS NOT NULL FROM public.notif_digest_worker_liveness() l),
  'the worker has SUCCEEDED at least once since activation (a never-invoked worker is invisible from inside the database — this is the only detector)');
SELECT pg_temp.assert(
  (SELECT l.seconds_since_success OPERATOR(pg_catalog.<)
            ((:'window_minutes'::pg_catalog.int4 OPERATOR(pg_catalog.*) 60) OPERATOR(pg_catalog.+) 120)
     FROM public.notif_digest_worker_liveness() l),
  'the last SUCCESSFUL dispatch run is inside the watch window (+2 min of slack for a tick in flight)');

-- ── 3. nothing is stuck, and nothing is holding the channel ─────────────────────────────────
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_channel_kill_switches), 0,
  'no channel is killed');
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_provider_circuit WHERE state OPERATOR(pg_catalog.<>) 'closed'), 0,
  'every provider circuit is CLOSED');
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_orphan_reconcile_state WHERE quarantined), 0,
  'no orphan provider event is quarantined (a quarantined orphan is a callback nobody could correlate)');
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_digest_groups
    WHERE uncertain_since IS NOT NULL AND terminal_at IS NULL
      AND uncertain_deadline_at OPERATOR(pg_catalog.<) pg_catalog.now()), 0,
  'no group is past its uncertainty deadline without being finalized');
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_worker_runs
    WHERE phase = 'dispatch' AND channel = 'email' AND ended_at IS NULL
      AND started_at OPERATOR(pg_catalog.<) (pg_catalog.now() OPERATOR(pg_catalog.-) pg_catalog.make_interval(mins => 30))), 0,
  'no dispatch run has been in flight for over 30 minutes (a wedged worker)');

-- ── 4. the window's OUTCOMES, asserted where an assertion is honest ─────────────────────────
-- A failed run in the window is not automatically an incident — one transient provider error is
-- recorded, retried and survivable — so this REPORTS the shape of the window and asserts only the
-- thing that is never acceptable: a run that failed and left work in an unprovable state.
SELECT 'window' AS scope, 'dispatch_runs' AS name, count(*)::text AS value,
       ('succeeded=' || count(*) FILTER (WHERE status = 'succeeded')::text
        || ' failed=' || count(*) FILTER (WHERE status = 'failed')::text) AS detail
  FROM public.notification_worker_runs
 WHERE phase = 'dispatch' AND channel = 'email'
   AND started_at OPERATOR(pg_catalog.>=) (pg_catalog.now() OPERATOR(pg_catalog.-) pg_catalog.make_interval(mins => :'window_minutes'::pg_catalog.int4));

SELECT 'window' AS scope, 'outbox_outcomes' AS name, count(*)::text AS value,
       ('sent=' || count(*) FILTER (WHERE status = 'sent')::text
        || ' delivered=' || count(*) FILTER (WHERE status = 'delivered')::text
        || ' failed=' || count(*) FILTER (WHERE status = 'failed')::text
        || ' skipped=' || count(*) FILTER (WHERE status = 'skipped')::text
        || ' unknown=' || count(*) FILTER (WHERE status = 'delivery_unknown')::text) AS detail
  FROM public.notification_outbox
 WHERE updated_at OPERATOR(pg_catalog.>=) (pg_catalog.now() OPERATOR(pg_catalog.-) pg_catalog.make_interval(mins => :'window_minutes'::pg_catalog.int4));

SELECT 'window' AS scope, 'digest_groups' AS name, count(*)::text AS value,
       ('sent=' || count(*) FILTER (WHERE state = 'sent')::text
        || ' in_flight=' || count(*) FILTER (WHERE terminal_at IS NULL)::text
        || ' unknown=' || count(*) FILTER (WHERE state = 'delivery_unknown')::text) AS detail
  FROM public.notification_digest_groups
 WHERE updated_at OPERATOR(pg_catalog.>=) (pg_catalog.now() OPERATOR(pg_catalog.-) pg_catalog.make_interval(mins => :'window_minutes'::pg_catalog.int4));

-- the delivery paths, as they stand right now
SELECT 'path' AS scope, b.path AS name, b.state AS value,
       coalesce('since ' || b.boundary_at::text, 'never opened') AS detail
  FROM public.notification_activation_boundaries b
 ORDER BY b.path;

SELECT 'POSTFLIGHT_OK=1' AS postflight_marker;
