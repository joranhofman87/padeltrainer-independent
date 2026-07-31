-- ===========================================================================
-- preflight.sql — run BEFORE applying the three PR #615 migrations, and again
-- AFTER any aborted apply (rehearsals B/C) to prove nothing partial persisted.
-- Asserts the target is the right, un-migrated database, measures the inputs
-- that drive the ACCESS EXCLUSIVE rewrite window (A_window) and emits the
-- recommended lock/statement-timeout CAPs the orchestrator binds to db push.
-- Reads only. Column-absence is checked via information_schema.columns (a
-- regclass cannot detect a column); table-absence via to_regclass.
-- ===========================================================================
\ir _assert.sql

-- ---- 1. right database: the base tables the migration ALTERs must exist ----
SELECT pg_temp.assert(to_regclass('public.email_address_state')   IS NOT NULL,
  'base table email_address_state exists (correct database)');
SELECT pg_temp.assert(to_regclass('public.email_delivery_events') IS NOT NULL,
  'base table email_delivery_events exists (correct database)');
SELECT pg_temp.assert(to_regclass('public.notification_event_types') IS NOT NULL,
  'notification_event_types exists (digest schema already on main)');
SELECT pg_temp.assert(to_regprocedure('public.is_academy_manager(uuid,uuid)') IS NOT NULL,
  'is_academy_manager(uuid,uuid) exists (reader dependency)');

-- ---- 2. the PR #615 delta must be ABSENT (un-migrated / cleanly aborted) ---
-- column-absence via information_schema.columns (NOT to_regclass)
SELECT pg_temp.assert(
  NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='email_address_state'
               AND column_name='is_suppressed'),
  'email_address_state.is_suppressed is ABSENT (migration 20261006100000 not applied)');
SELECT pg_temp.assert(
  NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='email_address_state'
               AND column_name='provider_suppressed_active'),
  'email_address_state.provider_suppressed_active is ABSENT');
SELECT pg_temp.assert(to_regclass('public.notification_orphan_reconcile_state')   IS NULL,
  'notification_orphan_reconcile_state is ABSENT (migration 20261006110000 not applied)');
SELECT pg_temp.assert(to_regclass('public.notification_orphan_reconcile_actions') IS NULL,
  'notification_orphan_reconcile_actions is ABSENT');
SELECT pg_temp.assert(to_regprocedure('public.reconcile_orphan_provider_events(uuid,text,timestamptz,int)') IS NULL,
  'reconcile_orphan_provider_events(...) is ABSENT');

-- ---- 3. production row counts (dry-run scope evidence) ---------------------
SELECT pg_temp.note('email_address_state rows = '   || (SELECT count(*) FROM public.email_address_state));
SELECT pg_temp.note('email_delivery_events rows = ' || (SELECT count(*) FROM public.email_delivery_events));

-- ---- 4. A_window inputs + recommended timeout CAPs ------------------------
-- The ADD COLUMN is_suppressed ... GENERATED ALWAYS ... STORED forces a full
-- table rewrite of email_address_state under ACCESS EXCLUSIVE. Size drives the
-- rewrite (A_window). CAP_LOCK bounds LOCK ACQUISITION (abort fast if writers
-- hold the table); CAP_STMT bounds total statement time (rewrite duration).
DO $$
DECLARE
  v_rows     bigint := (SELECT count(*) FROM public.email_address_state);
  v_bytes    bigint := pg_total_relation_size('public.email_address_state');
  v_cap_lock int    := 3000;                                          -- ms: fail fast on lock contention
  v_cap_stmt bigint := 30000 + ceil(v_bytes / (10.0*1024*1024))::bigint * 1000;  -- 30s + ~10MB/s rewrite budget
BEGIN
  RAISE NOTICE 'note: A_window input: email_address_state rows=% total_bytes=% (~% MiB)',
    v_rows, v_bytes, round(v_bytes/1024.0/1024.0, 1);
  RAISE NOTICE 'note: CAP_LOCK (recommended lock_timeout)      = % ms', v_cap_lock;
  RAISE NOTICE 'note: CAP_STMT (recommended statement_timeout) = % ms', v_cap_stmt;
  RAISE NOTICE 'note: bind these via the orchestrator before db push (PGOPTIONS -c lock_timeout / -c statement_timeout)';
END $$;

SELECT pg_temp.note('preflight: correct un-migrated database; delta absent; CAPs emitted');
