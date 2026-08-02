-- ===========================================================================
-- clone_wipe.sql — CLONE-ONLY. Return a rehearsal target to bare metal.
--
-- Reloading two tables cannot undo a migration. After rehearsal A or D the
-- target carries all three #615 migrations — new columns, functions, tables,
-- constraints and three ledger rows; after C it carries a PREFIX; a failed
-- migration can leave a half-applied mixture. A reset that only truncates rows
-- would hand the next rehearsal a target that is not pristine and call it one.
--
-- So the reset is a real rebuild: drop everything the build created, including
-- the migration ledger, and start again from an empty project.
--
-- Refuses unless the shims are present, which only a rehearsal target has —
-- production never runs this file, and could not: it has real pg_cron/pg_net.
-- ===========================================================================
\ir _assert.sql

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname IN ('pg_cron', 'pg_net')) THEN
    RAISE EXCEPTION 'refusing to wipe: this target has the REAL pg_cron/pg_net extensions, so it is not a rehearsal target built by this tooling';
  END IF;
  IF to_regclass('net.rehearsal_target_marker') IS NULL THEN
    RAISE EXCEPTION 'refusing to wipe: the rehearsal marker is absent, so this is not a target built by clone-build-baseline';
  END IF;
END $$;

DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT USAGE ON SCHEMA public TO PUBLIC;

DROP SCHEMA IF EXISTS cron CASCADE;
DROP SCHEMA IF EXISTS net CASCADE;

-- STORAGE IS PLATFORM-OWNED AND SURVIVES A SCHEMA DROP. Migrations insert
-- buckets (e.g. `avatars`, with no ON CONFLICT) and create policies on
-- storage.objects; both persist, so replaying the chain after a naive wipe hits
-- duplicate-key and duplicate-policy errors. Clear the rows and the policies
-- this tooling's chain created, without touching the schema itself.
DO $$
DECLARE r record;
BEGIN
  IF to_regclass('storage.objects') IS NOT NULL THEN
    EXECUTE 'DELETE FROM storage.objects';
    FOR r IN SELECT policyname FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', r.policyname);
    END LOOP;
  END IF;
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    EXECUTE 'DELETE FROM storage.buckets';
  END IF;
END $$;

-- Vault secrets and database-webhook triggers are equally persistent.
DO $$
DECLARE r record;
BEGIN
  IF to_regclass('vault.secrets') IS NOT NULL THEN
    BEGIN EXECUTE 'DELETE FROM vault.secrets'; EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'cannot clear vault.secrets on this target — refusing to claim a pristine rebuild';
    END;
  END IF;
  FOR r IN SELECT c.relname, t.tgname FROM pg_trigger t
             JOIN pg_class c ON c.oid = t.tgrelid
             JOIN pg_proc p ON p.oid = t.tgfoid
            WHERE NOT t.tgisinternal AND p.proname = 'http_request' LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', r.tgname, r.relname);
  END LOOP;
END $$;

-- The migration ledger must go too, or `supabase db push` believes the schema is
-- already applied and the rebuild silently produces a SUFFIX instead of the full
-- chain. (The real-Postgres lifecycle test caught this being missing.)
DO $$
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
    EXECUTE 'DELETE FROM supabase_migrations.schema_migrations';
  END IF;
END $$;

SELECT pg_temp.assert(to_regclass('public.email_address_state') IS NULL,
  'the affected tables are gone — the target is bare again');
DO $$
DECLARE n bigint := 0;
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN EXECUTE 'SELECT count(*) FROM storage.buckets' INTO n; END IF;
  IF n <> 0 THEN RAISE EXCEPTION 'storage still holds % bucket(s) — the chain would fail on a duplicate insert', n; END IF;
  n := 0;
  SELECT count(*) INTO n FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects';
  IF n <> 0 THEN RAISE EXCEPTION '% storage policy/policies survive — the chain would fail on a duplicate policy', n; END IF;
END $$;
DO $$
DECLARE n bigint := 0;
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM supabase_migrations.schema_migrations' INTO n;
  END IF;
  IF n <> 0 THEN
    RAISE EXCEPTION 'the migration ledger still holds % row(s) — the next build would apply a SUFFIX, not the full chain', n;
  END IF;
  RAISE NOTICE 'the migration ledger is empty: the next build applies the FULL chain';
END $$;
SELECT pg_temp.note('rehearsal target wiped to bare metal (schema, shims and migration ledger)');
