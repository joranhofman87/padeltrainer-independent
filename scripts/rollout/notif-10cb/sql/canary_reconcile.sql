-- 10c-b RU2 — reconcile ONE canary run. Takes :run_id.
--
-- WHY THIS IS A FILE AND NOT A `psql -c`. It was an inline `-c` statement, and that put it outside
-- the one protection this bundle depends on: an inline statement runs in its own psql process under
-- the role/database search_path, so the artifacts' path pins say nothing about it. Its `::uuid` cast
-- is a type name, resolved through that path like any other. Every statement this bundle sends to
-- production is now an enumerated artifact that pins the path itself — one rule, and
-- verify/enablement-selftest.sh fails if a `-c` reappears.
--
-- RECONCILING IS NOT PASSING: reconcile_notification_digest_run succeeds for ANY run that exists,
-- whatever its phase, status or outcome. canary_verify.sql is what decides whether the canary
-- delivered, and the dispatcher runs it immediately after this.
\set ON_ERROR_STOP on
-- NAME RESOLUTION IS PINNED FOR THE WHOLE SESSION, before any include and before any statement.
-- See canary_invoke.sql for the full reasoning; the short version is that ordering search_path is
-- not a defence, because function resolution prefers an exact-arity candidate over pg_catalog's
-- VARIADIC "any" wherever that schema sits. Only excluding it works.
SET search_path = pg_catalog;

SELECT * FROM public.reconcile_notification_digest_run(:'run_id'::pg_catalog.uuid);

-- N4 M1 (AC-6): close the deliberate-invocation record this run claimed. 'completed' demands
-- the evidence (the bound run has ended) — resolve() refuses anything less, so this line can
-- never wave an unverified invocation through. 'already_resolved' on a re-run is fine.
SELECT public.resolve_notification_worker_invocation(i.id, 'completed') AS invocation_resolution
  FROM public.notification_worker_invocations i
 WHERE i.worker_run_id = :'run_id'::pg_catalog.uuid
   AND i.status = 'started';
