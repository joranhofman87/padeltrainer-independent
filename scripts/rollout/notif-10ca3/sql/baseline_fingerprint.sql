-- ===========================================================================
-- baseline_fingerprint.sql — the pristine-baseline identity of a rehearsal target.
--
-- Rehearsals B and C deliberately leave the target broken, so each rehearsal must
-- start from the same state. Restoring four production snapshots is exactly what
-- this redesign removes, so the baseline is instead a LOCAL, verifiable object:
-- build it once, fingerprint it, and re-assert the fingerprint before every
-- rehearsal. A run that starts from a drifted baseline is refused.
--
-- The fingerprint covers what a migration measurement actually depends on:
--   * the SHAPE of the affected tables (columns, types, not-null, index set)
--   * the SIZE (live row count and on-disk bytes)
--   * the DISTRIBUTION that drives the backfill (state and event-type mix)
-- and deliberately NOT the content of any row: a fingerprint must never require
-- reading customer-shaped values, and the baseline is synthetic anyway.
--
-- Emits one machine-readable line per fact. Reads only.
-- ===========================================================================
\ir _assert.sql
\pset tuples_only on
\pset format unaligned
\pset footer off

-- shape: every column of the two affected tables, ordered, hashed together with
-- the index set. A migration that changed the shape changes this.
SELECT format('SHAPE %s', md5(string_agg(sig, E'\n' ORDER BY sig)))
FROM (
  SELECT format('%s.%s:%s:%s:%s', table_schema, table_name, column_name, data_type, is_nullable) AS sig
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name IN ('email_address_state', 'email_delivery_events')
  UNION ALL
  SELECT format('idx:%s:%s', tablename, indexdef) FROM pg_indexes
  WHERE schemaname = 'public' AND tablename IN ('email_address_state', 'email_delivery_events')
) x;

-- size: the two properties an ACCESS EXCLUSIVE rewrite/validate scales with
SELECT format('ROWS %s %s', 'email_address_state',   (SELECT count(*) FROM public.email_address_state));
SELECT format('ROWS %s %s', 'email_delivery_events', (SELECT count(*) FROM public.email_delivery_events));
SELECT format('BYTES %s %s', 'email_address_state',   pg_total_relation_size('public.email_address_state'));
SELECT format('BYTES %s %s', 'email_delivery_events', pg_total_relation_size('public.email_delivery_events'));

-- distribution: the backfill walks state-producing events per address, so its
-- cost depends on this mix, not on any address value
SELECT format('DIST state %s %s', state, count(*)) FROM public.email_address_state GROUP BY state ORDER BY state;
SELECT format('DIST event %s %s', event_type, count(*)) FROM public.email_delivery_events GROUP BY event_type ORDER BY event_type;

-- bloat approximation: dead tuples relative to live, so a rehearsal can state
-- how close its physical layout is to a long-lived production table
SELECT format('BLOAT %s live=%s dead=%s', relname, n_live_tup, n_dead_tup)
FROM pg_stat_user_tables
WHERE schemaname = 'public' AND relname IN ('email_address_state', 'email_delivery_events')
ORDER BY relname;

-- PII guard, asserted in the database itself: no synthetic address may look like
-- a real one. Every generated address lives on the reserved example.invalid TLD
-- (RFC 6761 / RFC 2606), which can never be delivered to.
SELECT format('SYNTHETIC %s', CASE WHEN (
  SELECT count(*) FROM public.email_address_state WHERE email NOT LIKE '%@%.example.invalid') = 0
  AND (SELECT count(*) FROM public.email_delivery_events WHERE recipient_email NOT LIKE '%@%.example.invalid') = 0
  THEN 'ok' ELSE 'VIOLATION' END);
