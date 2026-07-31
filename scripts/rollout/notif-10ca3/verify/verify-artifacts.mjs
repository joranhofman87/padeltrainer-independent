// ===========================================================================
// verify-artifacts.mjs — LOCAL executable proof for the 10c-a3 rollout SQL
// artifacts. Boots a real (embedded) Postgres, reproduces the Supabase
// default-privilege footgun, applies the REAL migration chain (base email
// tables from disk + the three PR #615 migrations via `git show`), then runs
// each artifact and MUTATION-PROVES that every assertion is load-bearing.
//
// No Docker, no production, no Supabase project. This is the evidence a human
// operator cannot get from prose: the SQL parses, executes, and fails when it
// should. The A/B/C/D rehearsals against real prod snapshots (supabase db push)
// remain owner-only and are documented in README.md.
//
// Run:  node scripts/rollout/notif-10ca3/verify/verify-artifacts.mjs
// ===========================================================================
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { readFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const SQL_DIR = join(__dirname, '..', 'sql');
const PR615 = 'feat/notif-10ca3-pr1-email-reliability';
const PORT = 54357;

const readSql = (name) => readFileSync(join(SQL_DIR, name), 'utf8');
const migMain = (f) => readFileSync(join(REPO, 'supabase', 'migrations', f), 'utf8');
const migPR615 = (f) => execFileSync('git', ['show', `${PR615}:supabase/migrations/${f}`], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 27 });

// Transform a psql artifact into something node-pg can run in one simple query:
// inline the \i _assert.sql include, then drop every remaining backslash meta
// command. The DO/RAISE-based assertions are the actual pass/fail mechanism, so
// stripping ON_ERROR_STOP does not weaken them (simple-query already aborts the
// whole batch on the first error, exactly like ON_ERROR_STOP).
function prepared(name) {
  const assertBody = readSql('_assert.sql').replace(/^\\.*$/gm, '');
  // NB: use a function replacement — a string replacement would treat the
  // `$$` dollar-quotes in assertBody as `$`-escapes and corrupt the SQL.
  let text = readSql(name).replace(/^\\ir? _assert\.sql\s*$/m, () => assertBody);
  text = text.replace(/^\\.*$/gm, '');
  return text;
}

const { Client } = pg;
const conn = () => new Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres` });

let PASS = 0, FAIL = 0;
const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (ok) { PASS++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { FAIL++; console.error(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
}

async function runOk(c, name, sqlName) {
  const notices = [];
  const onNotice = (n) => notices.push(n.message);
  c.on('notice', onNotice);
  try {
    await c.query(prepared(sqlName));
    const okCount = notices.filter((m) => m.startsWith('ok:')).length;
    record(name, true, `${okCount} assertions passed`);
    // surface A_window / CAP evidence emitted by preflight
    for (const m of notices.filter((m) => /A_window|CAP_/.test(m))) console.log(`        · ${m}`);
  } catch (e) {
    record(name, false, `unexpected error: ${e.message}`);
  } finally {
    c.removeListener('notice', onNotice);
  }
}

// run an artifact after applying a mutation, inside a rolled-back transaction,
// expecting the artifact to FAIL with an ASSERT/RAISE (proving it is load-bearing)
async function runMutationExpectFail(c, name, mutationSql, sqlName, transformArtifact) {
  await c.query('BEGIN');
  try {
    await c.query(mutationSql);
    let text = prepared(sqlName);
    if (transformArtifact) text = transformArtifact(text);
    let failed = false, msg = '';
    try { await c.query(text); }
    catch (e) { failed = true; msg = e.message; }
    record(name, failed, failed ? `correctly failed: ${msg.split('\n')[0].slice(0, 120)}` : 'artifact PASSED despite mutation (assertion is NOT load-bearing)');
  } finally {
    await c.query('ROLLBACK').catch(() => {});
  }
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'rollout-verify-'));
  const epg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  const setup = conn(); await setup.connect();
  try {
    // ---- roles + default-privilege footgun (so REVOKEs are meaningful) -----
    await setup.query(`SET check_function_bodies = off;`);
    await setup.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);

    // ---- auth stubs (present on a real Supabase clone) ---------------------
    await setup.query(`
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT coalesce(
          nullif(current_setting('request.jwt.claim.sub', true), ''),
          nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
        )::uuid $$;`);

    // ---- prod-shaped public stubs the reader/fixture/postflight touch ------
    await setup.query(`
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

    // ---- digest stubs (mirror the realpg harness) — the on-main digest chain
    //      the orphan migration depends on (notification_provider_events, groups,
    //      worker_runs). notification_event_types is base-shaped; 20261002100000
    //      adds digest_engine_enabled.
    await setup.query(`
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

    // ---- base email chain + on-main digest chain (already on main) ---------
    await setup.query(migMain('20260615110000_email_delivery_tables.sql'));
    await setup.query(migMain('20260615110010_record_email_event.sql'));
    for (const f of ['20261002100000_notification_digest_schema_foundation.sql',
      '20261003100000_notification_digest_acl_lockdown.sql',
      '20261004100000_notification_digest_state_machine.sql']) {
      await setup.query(migMain(f));
    }
    console.log('applied base email chain + on-main digest chain (PRE state)');

    // ===== PRE state: preflight must PASS (delta absent) =====================
    console.log('\n[PRE] preflight (delta absent):');
    { const c = conn(); await c.connect();
      await runOk(c, 'preflight PASS (un-migrated)', 'preflight.sql');
      // mutation: pre-create the is_suppressed column -> preflight must fail
      await runMutationExpectFail(c, 'preflight mutation: is_suppressed present -> fail',
        `ALTER TABLE public.email_address_state ADD COLUMN is_suppressed boolean;`, 'preflight.sql');
      await c.end();
    }

    // ---- apply the three PR #615 migrations (POST state) -------------------
    await setup.query(migPR615('20261006100000_email_delivery_concurrency_suppression.sql'));
    await setup.query(migPR615('20261006110000_reconcile_orphan_provider_events.sql'));
    await setup.query(migPR615('20261006120000_readers_canonical_is_suppressed.sql'));
    console.log('\napplied the three 20261006* PR #615 migrations (POST state)');

    // ===== POST state: postflight / acl / ledger / fixture ==================
    console.log('\n[POST] postflight:');
    { const c = conn(); await c.connect();
      await runOk(c, 'postflight PASS', 'postflight.sql');
      await runMutationExpectFail(c, 'postflight mutation: digest engine enabled -> fail',
        `INSERT INTO public.notification_event_types(key,supports_digest,digest_engine_enabled) VALUES ('x',true,true);`, 'postflight.sql');
      await runMutationExpectFail(c, 'postflight mutation: drop append-only trigger -> fail',
        `DROP TRIGGER trg_orphan_actions_immutable ON public.notification_orphan_reconcile_actions;`, 'postflight.sql');
      await c.end();
    }

    console.log('\n[POST] acl_matrix:');
    { const c = conn(); await c.connect();
      await runOk(c, 'acl_matrix PASS', 'acl_matrix.sql');
      await runMutationExpectFail(c, 'acl mutation: grant anon INSERT on state -> fail',
        `GRANT INSERT ON public.notification_orphan_reconcile_state TO anon;`, 'acl_matrix.sql');
      await runMutationExpectFail(c, 'acl mutation: grant authenticated EXECUTE on internal helper -> fail',
        `GRANT EXECUTE ON FUNCTION public.email_event_rank(text) TO authenticated;`, 'acl_matrix.sql');
      await c.end();
    }

    console.log('\n[POST] ledger_verification:');
    { const c = conn(); await c.connect();
      await runOk(c, 'ledger_verification PASS', 'ledger_verification.sql');
      await runMutationExpectFail(c, 'ledger mutation: out-of-domain state row -> fail',
        `ALTER TABLE public.email_address_state DROP CONSTRAINT email_address_state_state_check;
         INSERT INTO public.email_address_state(email,state) VALUES ('bad@x','bogus');`, 'ledger_verification.sql');
      await c.end();
    }

    console.log('\n[POST] academy_fixture (precedence + rollback):');
    { const c = conn(); await c.connect();
      await runOk(c, 'academy_fixture PASS', 'academy_fixture.sql');
      // mutation A: strip the manager claim -> SECURITY DEFINER auth gate must fire (42501)
      await c.query('BEGIN');
      try {
        let failed = false, msg = '';
        const noClaim = prepared('academy_fixture.sql')
          .replace(/SELECT set_config\('request\.jwt\.claims'[^;]*;/, 'SELECT 1;')
          .replace(/SELECT set_config\('request\.jwt\.claim\.sub'[^;]*;/, 'SELECT 1;');
        try { await c.query(noClaim); } catch (e) { failed = true; msg = e.message; }
        record('fixture mutation: no manager claim -> 42501 auth failure', failed && /not authorized|42501/.test(msg),
          failed ? `blocked: ${msg.split('\n')[0].slice(0, 90)}` : 'reader ran without manager auth');
      } finally { await c.query('ROLLBACK').catch(() => {}); }
      // mutation B: remove the registered-override suppression seed -> case1 assertion fails
      { const noSeed = prepared('academy_fixture.sql')
          .replace(/\('reg-bounced@example\.test',\s*'hard_bounced',\s*false,\s*'2026-07-01T00:00:00Z'\),/, '');
        let failed = false, msg = '';
        try { await c.query(noSeed); } catch (e) { failed = true; msg = e.message; }
        await c.query('ROLLBACK').catch(() => {});
        record('fixture mutation: drop reg-bounced seed -> case1 fails', failed && /case1|exactly the four/.test(msg),
          failed ? `blocked: ${msg.split('\n')[0].slice(0, 90)}` : 'case1 passed without its suppression row');
      }
      await c.end();
    }

    console.log(`\n================  ${PASS} passed, ${FAIL} failed  ================`);
  } finally {
    await setup.end().catch(() => {});
    await epg.stop().catch(() => {});
  }
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
