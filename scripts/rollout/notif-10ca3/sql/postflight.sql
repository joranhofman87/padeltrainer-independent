-- ===========================================================================
-- postflight.sql — run AFTER the three PR #615 migrations are applied.
-- Self-contained: asserts the exact 20261006* delta landed, the reconcile
-- ledger is INERT and append-only, and the digest engine is still disabled.
-- Every check fails loudly (RAISE EXCEPTION) under psql -v ON_ERROR_STOP=1.
-- Reads only; mutates nothing. Safe to re-run.
-- ===========================================================================
\ir _assert.sql

-- --- 1. email suppression migration (20261006100000) -----------------------
SELECT pg_temp.assert(
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='email_address_state'
            AND column_name='is_suppressed'),
  'email_address_state.is_suppressed column exists');

SELECT pg_temp.assert(
  (SELECT is_generated FROM information_schema.columns
     WHERE table_schema='public' AND table_name='email_address_state'
       AND column_name='is_suppressed') = 'ALWAYS',
  'email_address_state.is_suppressed is GENERATED ALWAYS (single source of truth)');

SELECT pg_temp.assert(
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='email_address_state'
            AND column_name='provider_suppressed_active'),
  'email_address_state.provider_suppressed_active column exists');

SELECT pg_temp.assert(to_regprocedure(
  'public.record_email_event(text,text,text,text,text,text,uuid,uuid,uuid,timestamptz)') IS NOT NULL,
  'record_email_event(...) present (single writer)');
SELECT pg_temp.assert(to_regprocedure('public.is_email_suppressed(text)') IS NOT NULL,
  'is_email_suppressed(text) present');
SELECT pg_temp.assert(to_regprocedure('public.reset_email_suppression(text)') IS NOT NULL,
  'reset_email_suppression(text) present');
SELECT pg_temp.assert(to_regprocedure(
  'public.email_state_transition(text,timestamptz,timestamptz,text,text,timestamptz)') IS NOT NULL,
  'email_state_transition(...) shared helper present');
SELECT pg_temp.assert(to_regprocedure('public.email_event_rank(text)') IS NOT NULL,
  'email_event_rank(text) present (total ordering)');

-- --- 2. orphan-reconcile migration (20261006110000) ------------------------
SELECT pg_temp.assert(to_regclass('public.notification_orphan_reconcile_state')  IS NOT NULL,
  'notification_orphan_reconcile_state table exists');
SELECT pg_temp.assert(to_regclass('public.notification_orphan_reconcile_actions') IS NOT NULL,
  'notification_orphan_reconcile_actions table exists');

SELECT pg_temp.assert(
  (SELECT relrowsecurity FROM pg_class WHERE oid='public.notification_orphan_reconcile_state'::regclass),
  'RLS enabled on notification_orphan_reconcile_state');
SELECT pg_temp.assert(
  (SELECT relrowsecurity FROM pg_class WHERE oid='public.notification_orphan_reconcile_actions'::regclass),
  'RLS enabled on notification_orphan_reconcile_actions');

-- append-only enforcement: row-immutability trigger + statement no-truncate trigger
SELECT pg_temp.assert(
  EXISTS (SELECT 1 FROM pg_trigger
          WHERE tgname='trg_orphan_actions_immutable' AND NOT tgisinternal
            AND tgrelid='public.notification_orphan_reconcile_actions'::regclass),
  'append-only: trg_orphan_actions_immutable present');
SELECT pg_temp.assert(
  EXISTS (SELECT 1 FROM pg_trigger
          WHERE tgname='trg_orphan_actions_no_truncate' AND NOT tgisinternal
            AND tgrelid='public.notification_orphan_reconcile_actions'::regclass),
  'append-only: trg_orphan_actions_no_truncate present');

SELECT pg_temp.assert(to_regprocedure(
  'public.apply_notification_provider_event(uuid,text,text,uuid,text,timestamptz,timestamptz)') IS NOT NULL,
  'apply_notification_provider_event(...) present');
SELECT pg_temp.assert(to_regprocedure(
  'public.reconcile_orphan_provider_events(uuid,text,timestamptz,int)') IS NOT NULL,
  'reconcile_orphan_provider_events(...) present');
SELECT pg_temp.assert(to_regprocedure(
  'public.notification_orphan_reconcile_requeue(text,text,text)') IS NOT NULL,
  'notification_orphan_reconcile_requeue(...) present');
SELECT pg_temp.assert(to_regprocedure(
  'public.notification_orphan_reconcile_resolve(text,text,text)') IS NOT NULL,
  'notification_orphan_reconcile_resolve(...) present');

-- INERT: the reconcile queue/ledger must be empty immediately post-migration.
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM public.notification_orphan_reconcile_state)::bigint, 0::bigint,
  'notification_orphan_reconcile_state is empty (INERT)');
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM public.notification_orphan_reconcile_actions)::bigint, 0::bigint,
  'notification_orphan_reconcile_actions is empty (INERT)');

-- --- 3. canonical reader migration (20261006120000) ------------------------
SELECT pg_temp.assert(to_regprocedure(
  'public.get_academy_undeliverable_recipients(uuid)') IS NOT NULL,
  'get_academy_undeliverable_recipients(uuid) present');
SELECT pg_temp.assert(to_regprocedure(
  'public.get_players_overview(text,uuid,text,jsonb,text,text,integer,integer)') IS NOT NULL,
  'get_players_overview(...) present');

-- the readers must reference the canonical is_suppressed column, not the legacy
-- state-only predicate. (pg_get_functiondef is authoritative for the body.)
SELECT pg_temp.assert(
  pg_get_functiondef('public.get_academy_undeliverable_recipients(uuid)'::regprocedure)
    ILIKE '%is_suppressed%',
  'get_academy_undeliverable_recipients reads is_suppressed');
SELECT pg_temp.assert(
  pg_get_functiondef('public.get_players_overview(text,uuid,text,jsonb,text,text,integer,integer)'::regprocedure)
    ILIKE '%is_suppressed%',
  'get_players_overview reads is_suppressed');

-- --- 4. digest engine remains DISABLED throughout --------------------------
SELECT pg_temp.assert(
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='notification_event_types'
            AND column_name='digest_engine_enabled'),
  'notification_event_types.digest_engine_enabled kill-switch column exists');
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM public.notification_event_types WHERE digest_engine_enabled)::bigint, 0::bigint,
  'no notification_event_types row has digest_engine_enabled = true (engine OFF)');

SELECT pg_temp.note('postflight: all assertions passed');
