-- ===========================================================================
-- baseline.sql — emit a stable, machine-readable snapshot of invariants that
-- must be PRESERVED across the migration (row counts of the email tables that
-- the ADD COLUMN rewrite must not lose) plus a fingerprint of the readers that
-- is EXPECTED to change (they are re-emitted to is_suppressed). Pure emit: no
-- assertions. The orchestrator captures this pre- and post-migration and
-- compares (preserve-keys must match; reader fingerprints must differ).
--
-- Output: one `key=value` line per invariant on stdout (tuples-only, unaligned)
-- so it can be diffed/grepped. Runs on prod, a clone, or the local harness.
-- ===========================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
\pset pager off

SELECT 'eas_rows=' || count(*) FROM public.email_address_state;
SELECT 'ede_rows=' || count(*) FROM public.email_delivery_events;
-- state distribution (a rewrite that silently corrupts state would shift this)
SELECT 'eas_bad_state_rows=' || count(*) FROM public.email_address_state WHERE state <> 'ok';
-- reader body fingerprints — EXPECTED to differ pre vs post (re-emit to is_suppressed).
-- to_regprocedure(...) yields NULL (no error) when the function is absent, so the
-- md5 folds to 'absent' pre-migration and to a hash post-migration.
SELECT 'reader_academy_md5=' || coalesce(
  md5(pg_get_functiondef(to_regprocedure('public.get_academy_undeliverable_recipients(uuid)'))), 'absent');
SELECT 'reader_overview_md5=' || coalesce(
  md5(pg_get_functiondef(to_regprocedure('public.get_players_overview(text,uuid,text,jsonb,text,text,integer,integer)'))), 'absent');
