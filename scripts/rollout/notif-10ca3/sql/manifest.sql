-- ===========================================================================
-- manifest.sql — emit a CONCURRENCY-SAFE no-loss manifest of the email tables
-- plus evidence aggregates. Captured pre- (after the drain) and post-migration;
-- the compare requires every pre-existing key to still exist (new rows allowed).
--
-- Address keys and event ids are emitted as SALTED FINGERPRINTS (md5 of a
-- per-run secret salt || value) so no raw email PII is written to evidence and
-- fingerprints cannot be correlated across runs. Supply the salt with
--   psql -v salt=<hex> -f manifest.sql
-- Pure emit (tuples-only, unaligned) — one line per fact; no assertions.
-- ===========================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
\pset pager off

-- no-loss key sets (salted fingerprints; NEVER raw addresses)
SELECT 'EAS ' || md5(:'salt' || '|' || email)     FROM public.email_address_state;
SELECT 'EDE ' || md5(:'salt' || '|' || id::text)  FROM public.email_delivery_events;

-- evidence-only aggregates + reader fingerprints (readers MUST change post-migration)
SELECT 'EV eas_rows='            || count(*) FROM public.email_address_state;
SELECT 'EV ede_rows='            || count(*) FROM public.email_delivery_events;
SELECT 'EV eas_bad_state_rows='  || count(*) FROM public.email_address_state WHERE state <> 'ok';
SELECT 'EV reader_academy_md5='  || coalesce(
  md5(pg_get_functiondef(to_regprocedure('public.get_academy_undeliverable_recipients(uuid)'))), 'absent');
SELECT 'EV reader_overview_md5=' || coalesce(
  md5(pg_get_functiondef(to_regprocedure('public.get_players_overview(text,uuid,text,jsonb,text,text,integer,integer)'))), 'absent');
