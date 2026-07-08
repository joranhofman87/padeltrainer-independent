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
