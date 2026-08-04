-- 10c-b RU2 — the counters a disabled smoke must not move, in a form a machine can diff.
--
-- status.sql reports these too, alongside timestamps and liveness that legitimately change across
-- the smoke. That made "diff the counter rows" an instruction to the operator's eye, and an
-- instruction to the eye is not evidence. This prints the counters and nothing else, one strict
-- marker per line, so the dispatcher can compare two captures byte for byte.
--
-- A DELTA, never an absolute. Any absolute-zero assertion against a live system is meaningless:
-- something else running in the window is indistinguishable from the thing under test. What the
-- smoke proves is that the invocation moved nothing.
\set ON_ERROR_STOP on
SET search_path = pg_catalog;

SELECT format('SMOKE_COUNTER %s=%s', name, value) AS smoke_marker FROM (
  SELECT 'digest_groups'   AS name, count(*)::text AS value FROM public.notification_digest_groups
  UNION ALL
  SELECT 'digest_attempts',  count(*)::text FROM public.notification_digest_attempts
  UNION ALL
  SELECT 'worker_runs',      count(*)::text FROM public.notification_worker_runs
  UNION ALL
  SELECT 'provider_events',  count(*)::text FROM public.notification_provider_events
  UNION ALL
  SELECT 'outbox_pending',   count(*)::text FROM public.notification_outbox WHERE status = 'pending'
  UNION ALL
  SELECT 'group_attempts',   count(*)::text FROM public.notification_digest_group_attempts
  UNION ALL
  SELECT 'orphan_state',     count(*)::text FROM public.notification_orphan_reconcile_state
  -- STATE, not just a row count: the breaker is a fixed set of rows whose STATE moves, so counting
  -- them would never notice a trip. Same for the groups — a send changes state without changing the
  -- count, and `worker_runs` is the sentinel that catches the invocation itself either way.
  UNION ALL
  SELECT 'circuit_state',    string_agg(channel || '=' || state, ',' ORDER BY channel)
    FROM public.notification_provider_circuit
  UNION ALL
  SELECT 'group_states',     coalesce(string_agg(s.state || ':' || s.n::text, ',' ORDER BY s.state), '')
    FROM (SELECT state, count(*) AS n FROM public.notification_digest_groups GROUP BY state) s
) c ORDER BY name;
