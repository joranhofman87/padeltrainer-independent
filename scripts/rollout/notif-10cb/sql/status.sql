-- 10c-b RU2/RU3 — the READ. Answers "what state is the digest engine actually in?" without
-- changing anything, so an operator never has to infer it from silence or from a runbook's memory.
\set ON_ERROR_STOP on

SELECT 'engine' AS scope, e.key AS name,
       e.digest_engine_enabled::text AS value,
       e.digest_cutover::text AS detail
  FROM public.notification_event_types e
 WHERE e.digest_cutover OR e.digest_engine_enabled
 ORDER BY e.key;

SELECT 'cron' AS scope, 'notification-digest-worker' AS name,
       l.job_present::text AS value,
       ('active=' || l.job_active::text) AS detail
  FROM public.notif_digest_worker_liveness() l;

SELECT 'liveness' AS scope, 'last_dispatch_success' AS name,
       coalesce(l.last_success_at::text, '(never)') AS value,
       ('age_s=' || coalesce(l.seconds_since_success::text, 'n/a')
        || ' last=' || coalesce(l.last_status, '(none)')) AS detail
  FROM public.notif_digest_worker_liveness() l;

-- The counters a disabled smoke must not move. Reported, never asserted here: a live system's
-- absolute values are meaningless, only the DELTA across the smoke is evidence.
SELECT 'counter' AS scope, 'digest_groups' AS name, count(*)::text AS value, '' AS detail
  FROM public.notification_digest_groups
UNION ALL
SELECT 'counter', 'digest_attempts', count(*)::text, '' FROM public.notification_digest_attempts
UNION ALL
SELECT 'counter', 'worker_runs', count(*)::text, '' FROM public.notification_worker_runs
UNION ALL
SELECT 'counter', 'provider_events', count(*)::text, '' FROM public.notification_provider_events
ORDER BY 1, 2;
