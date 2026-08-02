-- ===========================================================================
-- rehearsal_inert_check.sql — the CLONE-SIDE gate for the supported model.
--
-- The withdrawn model proved provenance with a marker and a fence, because the
-- target was a copy of production and had to be shown to have come from a
-- quiesced instant. This target never held production state, so provenance is
-- not the question — INERTNESS is, and it is proven directly:
--
--   * cron jobs may EXIST (the schema build creates them) but none may be ACTIVE
--   * the pg_net queue and response table must be empty
--   * no Vault secrets, so no provider credential can be used even in principle
--   * no database webhooks, no outbound-capable triggers (incl. nested paths)
--   * no FDW servers
--   * no auth users — a rehearsal never carries a session that could act as one
--
-- Reads only. Never selects a cron command, pg_net URL/header/body, Vault secret
-- or any application row.
-- ===========================================================================
\ir _assert.sql

DO $$
DECLARE n bigint := 0;
BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM cron.job WHERE active' INTO n;
  END IF;
  IF n <> 0 THEN RAISE EXCEPTION 'rehearsal target has % ACTIVE cron job(s)', n; END IF;
END $$;

DO $$
DECLARE q bigint := 0; r bigint := 0; v bigint := 0; u bigint := 0;
BEGIN
  IF to_regclass('net.http_request_queue') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM net.http_request_queue' INTO q;
    IF to_regclass('net._http_response') IS NOT NULL THEN EXECUTE 'SELECT count(*) FROM net._http_response' INTO r; END IF;
  END IF;
  IF q <> 0 OR r <> 0 THEN RAISE EXCEPTION 'rehearsal target: % queued request(s), % response(s)', q, r; END IF;
  IF to_regclass('vault.secrets') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM vault.secrets' INTO v;
  END IF;
  IF v <> 0 THEN RAISE EXCEPTION 'rehearsal target holds % Vault secret(s)', v; END IF;
  IF to_regclass('auth.users') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM auth.users' INTO u;
  END IF;
  IF u <> 0 THEN RAISE EXCEPTION 'rehearsal target holds % auth user(s)', u; END IF;
END $$;

SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE NOT t.tgisinternal AND p.proname = 'http_request')::bigint, 0::bigint,
  'rehearsal target has ZERO database-webhook triggers');

WITH RECURSIVE outbound(oid) AS (
  SELECT p.oid FROM pg_proc p
   WHERE p.prosrc ~* '(net\.http_(post|get|delete)|http_post|http_get|dblink)'
  UNION
  SELECT c.oid FROM pg_proc c JOIN outbound o ON true
   WHERE c.oid <> o.oid
     AND c.prosrc ~* ('\m' || (SELECT proname FROM pg_proc WHERE oid = o.oid) || '\M')
)
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgfoid IN (SELECT oid FROM outbound))::bigint,
  0::bigint, 'rehearsal target has ZERO outbound-capable triggers, including nested call paths');

SELECT pg_temp.assert_eq((SELECT count(*) FROM pg_foreign_server)::bigint, 0::bigint,
  'rehearsal target has ZERO foreign servers / FDW wrappers');

SELECT pg_temp.note('rehearsal target inert: no active cron, empty pg_net queue/responses, no Vault secrets, no auth users, no webhooks/outbound triggers/FDWs');
