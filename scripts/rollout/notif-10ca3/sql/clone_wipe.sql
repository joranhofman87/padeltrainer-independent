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
    RAISE EXCEPTION 'refusing to wipe: this target has the REAL pg_cron/pg_net extensions, so it is not a shimmed rehearsal target';
  END IF;
  IF to_regclass('net.blocked_outbound_attempts') IS NULL THEN
    RAISE EXCEPTION 'refusing to wipe: the rehearsal shims are absent, so this is not a target built by clone-build-baseline';
  END IF;
END $$;

DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT USAGE ON SCHEMA public TO PUBLIC;

DROP SCHEMA IF EXISTS cron CASCADE;
DROP SCHEMA IF EXISTS net CASCADE;

-- the migration ledger must go too, or `supabase db push` believes the schema
-- is already applied and the rebuild silently produces a PREFIX
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
  IF to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM supabase_migrations.schema_migrations' INTO n;
  END IF;
  IF n <> 0 THEN
    RAISE EXCEPTION 'the migration ledger still holds % row(s) — the next build would apply a SUFFIX, not the full chain', n;
  END IF;
  RAISE NOTICE 'the migration ledger is empty: the next build applies the FULL chain';
END $$;
SELECT pg_temp.note('rehearsal target wiped to bare metal (schema, shims and migration ledger)');
