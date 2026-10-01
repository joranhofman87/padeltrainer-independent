-- LOCAL-ONLY seed, applied automatically by `supabase db reset` (never by `supabase db push`,
-- so it never touches production). Its only job is to grant service_role the table/sequence
-- privileges that exist out-of-band on the hosted project but aren't in the migration files —
-- without them the TypeScript data seed (scripts/db/seed-local.ts, which writes via the
-- service-role key over PostgREST) gets "permission denied". Actual seed DATA lives in that
-- script because it must create real auth users via the Auth admin API.
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;

-- ── Deny-list: tables that must stay default-deny even locally ────────────────────────────────
-- The blanket grant above is deliberately broad, but `academy_player_memberships` is default-deny
-- BY DESIGN (RLS on, zero policies, no named-role privileges — see
-- 20261113100000_u1a_academy_player_memberships.sql). Without this REVOKE a plain `supabase db reset`
-- silently hands service_role — which also carries BYPASSRLS — full access to it, so the default-deny
-- property would hold only on a freshly-pushed database and never locally or in CI, where every test
-- that asserts it runs. Re-revoke AFTER the grant, not before.
-- Existence-guarded on purpose: the U1a rollback drops the table, and a bare REVOKE against a missing
-- relation would break every later reset.
DO $$
BEGIN
  IF to_regclass('public.academy_player_memberships') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON public.academy_player_memberships FROM PUBLIC, anon, authenticated, service_role';
  END IF;
END $$;

-- The same applies to the U1b backfill logbook (20261114100000_u1b_membership_backfill_manifest.sql).
-- Kept as its OWN block rather than folded into the one above: U1a and U1b roll back independently,
-- and a shared list would make removing one unit's entry an edit to the other's.
DO $$
BEGIN
  IF to_regclass('public.membership_backfill_runs') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON public.membership_backfill_runs FROM PUBLIC, anon, authenticated, service_role';
  END IF;
  IF to_regclass('public.membership_backfill_items') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON public.membership_backfill_items FROM PUBLIC, anon, authenticated, service_role';
  END IF;
END $$;

-- And U2's erasure ledger (20261203100000_u2_account_scrub_operations.sql), which is default-deny for
-- a stronger reason than the tables above: it has no authorized caller AT ALL yet. Access will arrive
-- as narrow SECURITY DEFINER RPCs, and until they exist the only privilege anything should hold is
-- the owner's. The blanket grant above would hand service_role — which also carries BYPASSRLS — full
-- read/write on an append-only erasure record, locally and in CI, i.e. exactly where the ACL tests
-- run. `supabase db push` never applies this file, so production takes the migration's REVOKE and is
-- already correct; without this block only the environments that TEST the property would lack it.
DO $$
BEGIN
  IF to_regclass('public.account_scrub_operations') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON public.account_scrub_operations FROM PUBLIC, anon, authenticated, service_role';
  END IF;
END $$;
