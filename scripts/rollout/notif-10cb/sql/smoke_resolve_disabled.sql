-- N4 M1 (AC-6) — close the DISABLED smoke's invocation, with the evidence attached.
--
-- The disabled smoke is the one deliberate invocation whose worker NEVER starts a run: it
-- answers the exact disabled 200 before any DB work. So the generic run-evidence resolve
-- correctly refuses it forever, and without this step the invocation stays pending — blocking
-- every later smoke/canary/activate at _invocation_gate.sql, which is the single-flight rule
-- doing its job against an evidence gap this artifact closes.
--
-- The dispatcher runs this AFTER it has verified the response itself (200, exact disabled body,
-- zero counter delta). The RPC does not take the shell's word for it: it re-reads the pg_net
-- response row and re-verifies clean-200 + exact-disabled-body + postdates-the-open in SQL,
-- and it refuses any invocation that is not a pending smoke. Takes:
--   :invocation_request_id — the caller-generated open() identity (retry-survivable)
--   :net_request_id        — the pg_net request whose response is the evidence
\set ON_ERROR_STOP on
-- NAME RESOLUTION IS PINNED FOR THE WHOLE SESSION, before any statement. See canary_invoke.sql
-- for the reasoning; the short version is that ordering search_path is not a defence, because
-- resolution prefers an exact-arity candidate over pg_catalog's VARIADIC "any" wherever that
-- schema sits. Only excluding it works.
SET search_path = pg_catalog;

SELECT pg_catalog.format('SMOKE_INVOCATION_RESOLVED=%s',
  public.resolve_smoke_invocation_disabled(
    (SELECT id FROM public.notification_worker_invocations
      WHERE request_id = :'invocation_request_id'::pg_catalog.uuid),
    :'net_request_id'::pg_catalog.int8)) AS invocation_marker;
