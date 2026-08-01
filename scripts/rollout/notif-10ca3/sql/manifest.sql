-- ===========================================================================
-- manifest.sql — CONCURRENCY-SAFE, SNAPSHOT-CONSISTENT no-loss manifest of the
-- email tables plus evidence aggregates. Captured pre- (after the drain) and
-- post-migration; the compare requires every pre-existing key to still exist
-- (new rows allowed). Every query runs in ONE REPEATABLE READ READ ONLY
-- transaction so the fingerprint enumeration and the count(*) come from the
-- SAME snapshot — the fingerprint cardinality therefore equals eas_rows/ede_rows
-- exactly, and validate_manifest can reject an incomplete/regressed capture.
--
-- Address keys + event ids are SALTED SHA-256 fingerprints (pseudonymous, not
-- reversible without the per-run secret salt) — no raw email PII in evidence.
-- The salt is read from the environment via \getenv (psql >= 16) so it never
-- appears in process arguments:  ROLLOUT_SALT=<hex> psql -f manifest.sql
-- ===========================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
\pset pager off
\getenv salt ROLLOUT_SALT

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

-- no-loss key sets (salted SHA-256; NEVER raw addresses)
SELECT 'EAS ' || encode(sha256((:'salt' || '|' || email)::bytea), 'hex')    FROM public.email_address_state;
SELECT 'EDE ' || encode(sha256((:'salt' || '|' || id::text)::bytea), 'hex') FROM public.email_delivery_events;

-- evidence-only aggregates + reader fingerprints (readers MUST change post-migration)
SELECT 'EV eas_rows='            || count(*) FROM public.email_address_state;
SELECT 'EV ede_rows='            || count(*) FROM public.email_delivery_events;
SELECT 'EV eas_bad_state_rows='  || count(*) FROM public.email_address_state WHERE state <> 'ok';
SELECT 'EV reader_academy_md5='  || coalesce(
  md5(pg_get_functiondef(to_regprocedure('public.get_academy_undeliverable_recipients(uuid)'))), 'absent');
SELECT 'EV reader_overview_md5=' || coalesce(
  md5(pg_get_functiondef(to_regprocedure('public.get_players_overview(text,uuid,text,jsonb,text,text,integer,integer)'))), 'absent');

COMMIT;
