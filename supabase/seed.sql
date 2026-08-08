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
-- The same applies to the U1b backfill logbook (20261114100000_u1b_membership_backfill_manifest.sql):
-- both tables are default-deny by design and inert outside the local rehearsal, so the blanket grant
-- above must be undone for them too, on every reset, or the ACL tests would only be meaningful on a
-- freshly-pushed database.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'public.academy_player_memberships',
    'public.membership_backfill_runs',
    'public.membership_backfill_items'
  ] LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON %s FROM PUBLIC, anon, authenticated, service_role', t);
    END IF;
  END LOOP;
END $$;
