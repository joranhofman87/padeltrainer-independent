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

-- ABC-16/ABC-17 overlays. These are NOT default-deny — `authenticated` keeps SELECT so the player
-- pages stay readable — so the blanket grant above has to be undone selectively rather than wholesale:
-- re-revoke everything, then restore exactly the read the containment allows
-- (20261118110000_abc16_abc17_relationship_evidence_containment.sql, section 6).
--
-- service_role in particular must NOT regain direct access: both tables are in the backup catalogue
-- but are read through the SECURITY DEFINER `backup_export_table`, which holds EXECUTE, so a direct
-- grant is an unjustified standing privilege. Without this block the ACL assertions would hold on a
-- freshly-pushed database and fail on every local reset and CI run — which is exactly where the tests
-- that assert them execute.
DO $$
BEGIN
  IF to_regclass('public.academy_player_metadata') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON public.academy_player_metadata FROM PUBLIC, anon, authenticated, service_role';
    EXECUTE 'GRANT SELECT ON public.academy_player_metadata TO authenticated';
  END IF;
  IF to_regclass('public.academy_player_locations') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON public.academy_player_locations FROM PUBLIC, anon, authenticated, service_role';
    EXECUTE 'GRANT SELECT ON public.academy_player_locations TO authenticated';
  END IF;
END $$;
