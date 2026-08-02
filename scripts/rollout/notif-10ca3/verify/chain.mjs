// ===========================================================================
// chain.mjs — shared setup for the local proof harnesses (verify-artifacts.mjs,
// rehearsals.mjs). Boots an embedded Postgres, reproduces the Supabase
// default-privilege footgun, and applies the REAL migration chain:
//   base email tables + on-main digest chain (from the working tree) then the
//   three PR #615 migrations read at a PINNED COMMIT SHA (not a moving branch),
//   so the proof is deterministic and reproducible in CI.
// ===========================================================================
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
export const SQL_DIR = join(__dirname, '..', 'sql');

// SHA-PINNED source of the three PR #615 migrations. The pin lives in PINS.env
// (single source shared with run-rollout.sh) so CI evidence and the deployed
// commit cannot drift. Pinning a SHA (not the branch) makes the harness
// deterministic and lets CI fetch exactly this commit.
function readPin(key) {
  const txt = readFileSync(join(__dirname, '..', 'PINS.env'), 'utf8');
  const m = txt.match(new RegExp(`^${key}=([0-9a-f]{40})\\s*$`, 'm'));
  if (!m) throw new Error(`PINS.env is missing a valid ${key}`);
  return m[1];
}
export const PR615_SHA = readPin('PR615_SHA');
export const PR615_BRANCH = 'feat/notif-10ca3-pr1-email-reliability';
export const PR615_MIGS = [
  '20261006100000_email_delivery_concurrency_suppression.sql',
  '20261006110000_reconcile_orphan_provider_events.sql',
  '20261006120000_readers_canonical_is_suppressed.sql',
];

function shaPresent() {
  try { execFileSync('git', ['cat-file', '-e', `${PR615_SHA}^{commit}`], { cwd: REPO, stdio: 'ignore' }); return true; }
  catch { return false; }
}
let ENSURED = false;
function ensurePin() {
  if (ENSURED) return;
  if (!shaPresent()) {
    // CI checks out shallow; fetch the pinned commit's branch so `git show` resolves it.
    try { execFileSync('git', ['fetch', '--no-tags', '--depth', '1', 'origin', PR615_BRANCH], { cwd: REPO, stdio: 'ignore' }); }
    catch { /* fall through to the assertion below */ }
  }
  if (!shaPresent()) {
    throw new Error(`pinned PR615 commit ${PR615_SHA} is not reachable; in CI ensure fetch-depth:0 and that ${PR615_BRANCH} is fetched`);
  }
  ENSURED = true;
}

export const migMain = (f) => readFileSync(join(REPO, 'supabase', 'migrations', f), 'utf8');
export const migPR615 = (f) => { ensurePin(); return execFileSync('git', ['show', `${PR615_SHA}:supabase/migrations/${f}`], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 27 }); };

// Artifact transform: inline the `\ir _assert.sql` include, then strip remaining
// psql backslash meta-commands so node-pg can run the body as one simple query.
// The DO/RAISE assertions are the real pass/fail mechanism (simple-query already
// aborts the batch on first error, like ON_ERROR_STOP). Function replacement
// avoids `$$`-in-replacement corruption.
export function prepared(name) {
  const assertBody = readFileSync(join(SQL_DIR, '_assert.sql'), 'utf8').replace(/^\\.*$/gm, '');
  let text = readFileSync(join(SQL_DIR, name), 'utf8').replace(/^\\ir? _assert\.sql\s*$/m, () => assertBody);
  return text.replace(/^\\.*$/gm, '');
}
// manifest.sql is pure \set/\pset + SELECT; strip meta lines and run the SELECTs.
// (caller substitutes :'salt' with a literal before running via node-pg).
export function preparedPlain(name) {
  return readFileSync(join(SQL_DIR, name), 'utf8').replace(/^\\.*$/gm, '');
}

const { Client } = pg;
export function boot(port) {
  return (async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'rollout-chain-'));
    // UTF8, not the initdb default: the migration chain contains a self-test
    // whose translate() strings are multi-byte, and a SQL_ASCII cluster reports a
    // length mismatch that has nothing to do with the migration.
    const epg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port,
      persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=en_US.UTF-8'] });
    await epg.initialise();
    await epg.start();
    const url = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    return { epg, url, conn: () => new Client({ connectionString: url }) };
  })();
}

// PRE state (prod before #615): roles + footgun + auth + prod-shaped stubs +
// base email chain + on-main digest chain. Idempotent-ish; run once per DB.
export async function installPreState(c) {
  await c.query(`SET check_function_bodies = off;`);
  // roles are cluster-global — create once, idempotently (safe when installing
  // into a second fresh database on the same server for the rehearsals).
  await c.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
    END $$;`);
  await c.query(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
  await c.query(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT coalesce(
        nullif(current_setting('request.jwt.claim.sub', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
      )::uuid $$;`);
  await c.query(`
    CREATE TABLE public.invoices (id uuid PRIMARY KEY);
    CREATE TABLE public.academy_profiles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, slug text UNIQUE NOT NULL);
    CREATE TABLE public.academy_managers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      academy_profile_id uuid NOT NULL REFERENCES public.academy_profiles(id) ON DELETE CASCADE,
      user_id uuid NOT NULL, role text NOT NULL DEFAULT 'manager',
      UNIQUE(academy_profile_id, user_id));
    CREATE TABLE public.profiles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
      full_name text, email text);
    CREATE TABLE public.guest_players (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      trainer_id uuid, academy_profile_id uuid REFERENCES public.academy_profiles(id) ON DELETE CASCADE,
      full_name text NOT NULL, email text NOT NULL, phone text NOT NULL,
      linked_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
      CONSTRAINT guest_players_owner_check CHECK (trainer_id IS NOT NULL OR academy_profile_id IS NOT NULL));
    CREATE TABLE public.academy_player_metadata (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      academy_profile_id uuid, trainer_profile_id uuid,
      guest_player_id uuid REFERENCES public.guest_players(id) ON DELETE CASCADE,
      profile_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
      billing_email text, removed_at timestamptz, tag_ids uuid[] NOT NULL DEFAULT '{}',
      CONSTRAINT apm_owner_check CHECK ((academy_profile_id IS NOT NULL)::int + (trainer_profile_id IS NOT NULL)::int = 1),
      CONSTRAINT apm_guest_profile_xor CHECK (
        (guest_player_id IS NOT NULL AND profile_id IS NULL) OR
        (guest_player_id IS NULL AND profile_id IS NOT NULL)));
    CREATE UNIQUE INDEX idx_apm_guest   ON public.academy_player_metadata(academy_profile_id, guest_player_id) WHERE guest_player_id IS NOT NULL;
    CREATE UNIQUE INDEX idx_apm_profile ON public.academy_player_metadata(academy_profile_id, profile_id)      WHERE profile_id IS NOT NULL;
    CREATE OR REPLACE FUNCTION public.is_academy_manager(_user_id uuid, _academy_profile_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
      SELECT EXISTS (SELECT 1 FROM public.academy_managers
                     WHERE user_id = _user_id AND academy_profile_id = _academy_profile_id) $$;`);
  await c.query(`
    CREATE TABLE public.notification_event_types (
      key text PRIMARY KEY, supports_digest boolean NOT NULL DEFAULT false,
      required_delivery boolean NOT NULL DEFAULT false);
    CREATE TABLE public.notification_contacts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), person_id uuid, user_id uuid, guest_player_id uuid,
      channel text NOT NULL DEFAULT 'email', destination_normalized text NOT NULL,
      consent_status text NOT NULL DEFAULT 'unknown', consent_scope text NOT NULL DEFAULT 'global',
      consent_academy_profile_id uuid, consent_trainer_id uuid, revoked_at timestamptz,
      is_primary boolean NOT NULL DEFAULT false, verified_at timestamptz);
    CREATE FUNCTION public.is_notification_consent_in_scope(
      _consent_scope text, _consent_academy uuid, _consent_trainer uuid, _ctx_academy uuid, _ctx_trainer uuid)
    RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
      SELECT CASE WHEN _consent_scope = 'global' THEN true
        WHEN _consent_scope = 'tenant' THEN
              (_consent_academy IS NULL OR (_ctx_academy IS NOT NULL AND _ctx_academy = _consent_academy))
          AND (_consent_trainer IS NULL OR (_ctx_trainer IS NOT NULL AND _ctx_trainer = _consent_trainer))
          AND (_consent_academy IS NOT NULL OR _consent_trainer IS NOT NULL)
        ELSE false END $$;
    CREATE TABLE public.notification_outbox (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), channel text NOT NULL DEFAULT 'email',
      event_type text, template_key text, status text NOT NULL DEFAULT 'pending',
      payload jsonb, public_summary jsonb, skip_reason text, destination_normalized text,
      contact_id uuid REFERENCES public.notification_contacts(id) ON DELETE SET NULL,
      recipient_person_id uuid, recipient_user_id uuid, recipient_guest_player_id uuid,
      tenant_academy_profile_id uuid, tenant_trainer_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT notification_outbox_status_check CHECK (status IN
        ('pending','processing','sent','delivered','failed','skipped','cancelled')));
    CREATE TABLE public.notification_preferences_v2 (
      user_id uuid NOT NULL, event_type text NOT NULL, email_frequency text NOT NULL DEFAULT 'instant',
      UNIQUE (user_id, event_type));
    CREATE TABLE public.persons (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid UNIQUE, email text);`);
  await c.query(migMain('20260615110000_email_delivery_tables.sql'));
  await c.query(migMain('20260615110010_record_email_event.sql'));
  for (const f of ['20261002100000_notification_digest_schema_foundation.sql',
    '20261003100000_notification_digest_acl_lockdown.sql',
    '20261004100000_notification_digest_state_machine.sql']) {
    await c.query(migMain(f));
  }
}

export async function applyPr615(c) {
  for (const f of PR615_MIGS) await c.query(migPR615(f));
}
