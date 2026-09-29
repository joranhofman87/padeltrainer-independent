// @vitest-environment node
// PTF release packet (docs/deployment/ptf-release) on a REAL PostgreSQL server, driven by real psql.
//
// Harness: the function's production shape — Supabase's roles and default function privileges, the
// overview's input tables (same shape as playersOverviewCurrentTraining.pglite.test.ts), the canonical
// migration chain for get_players_overview, and a ledger holding exactly the 620 versions production
// records after the ACL correction (the repository's versions minus PTF, plus the six F0 versions and
// the ACL version). F0/ACL touch neither this function nor the tables it reads (release-prep record).
//
// Proves: the harness reproduces the production baseline receipt; every apply guard refuses and changes
// nothing; apply does not wait on open reader transactions; apply → exact end state; re-run is a no-op;
// the post-check passes only after apply and the refusal probe refuses; the composed function behaves;
// forward recovery restores the canonical body exactly; and a representative performance observation.
//
// Server: embedded PostgreSQL by default; PTF_PGBIN=<dir with initdb, pg_ctl, postgres> runs the same
// suite on other binaries (production is 17.6). psql: PTF_PSQL, else `psql` on PATH.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { Client } = pg;
const PORT = 54391;
const HOST = '127.0.0.1';
const PSQL = process.env.PTF_PSQL ?? 'psql';
const PGBIN = process.env.PTF_PGBIN;
const PACKET = join(process.cwd(), 'docs', 'deployment', 'ptf-release');
const MIG = (f: string) => readFileSync(join(process.cwd(), 'supabase', 'migrations', f), 'utf8');

const C_BASE = '98015eddaccd8ef67297c172db67495f5ff11a881ea28e1f024fb82741c3bc72';
const C_PTF = '901dc2c86de75066075c12e9da19e277d372da66c31b84433911b0e3cc07f900';
const C_RESTORED = 'b312bf6a1dcc0fbc35c9f2c24e7f947daaf1d312b422534003deeb8ed90b302e';
const BODY_LIVE = '0f42f53cab95b897e10ee0295f9185de15056a0cd904252c84bb117e0b7003f4';
const BODY_PTF = '22695d9ce5ccd20617d98af9123712701d55c8198ee0d607bd08a62fd503b8b2';
const PROD_ACL = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}';
const ARGS = 'p_scope text, p_scope_id uuid, p_search text, p_filters jsonb, p_sort text, p_sort_dir text, p_limit integer, p_offset integer';
const F0_ACL_VERSIONS = ['20261204100000', '20261204110000', '20261205100000', '20261206100000',
  '20261206110000', '20261206120000', '20261207100000'];

// fixture ids (small behaviour fixture)
const A = 'a1000000-0000-0000-0000-00000000000a';
const B = 'b1000000-0000-0000-0000-00000000000b';
const MGR_A = 'a1000000-0000-0000-0000-0000000000a1';
const MGR_B = 'b1000000-0000-0000-0000-0000000000b1';
const TS = 'c1000000-0000-0000-0000-000000000071';
const LOC = 'a1000000-0000-0000-0000-00000000e0a1';
const CYC_ON = 'cc100000-0000-0000-0000-0000000000c1';
const CYC_FU = 'cc100000-0000-0000-0000-0000000000c2';
const G_ON = '9a100000-0000-0000-0000-000000000001';
const G_FU = '9a100000-0000-0000-0000-000000000002';

let stopServer: () => Promise<void> = async () => {};
let db: pg.Client;
const extraClients: pg.Client[] = [];
async function newClient(): Promise<pg.Client> {
  const c = new Client({ connectionString: `postgresql://postgres:postgres@${HOST}:${PORT}/postgres` });
  c.on('error', () => { /* server stop at teardown; the test's own assertions report real failures */ });
  await c.connect();
  extraClients.push(c);
  return c;
}
let sysid = '';

async function startServer(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ptf-release-rp-'));
  if (!PGBIN) {
    const epg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: PORT, persistent: false });
    await epg.initialise();
    await epg.start();
    stopServer = async () => { await epg.stop(); };
    return;
  }
  const run = (cmd: string, args: string[]) => {
    const r = spawnSync(join(PGBIN, cmd), args, { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr || r.error}`);
  };
  run('initdb', ['-D', dir, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--locale=C']);
  run('pg_ctl', ['-D', dir, '-o', `-p ${PORT} -k ${dir} -c listen_addresses=${HOST}`, '-w', '-l', join(dir, 'log'), 'start']);
  stopServer = async () => { run('pg_ctl', ['-D', dir, '-m', 'fast', 'stop']); };
}

type Psql = { status: number | null; out: string; err: string; rec: Record<string, string> };
function psql(file: string, opts: { vars?: Record<string, string>; single?: boolean; path?: string } = {}): Psql {
  const args = ['-X', '-v', 'ON_ERROR_STOP=1', '-h', HOST, '-p', String(PORT), '-U', 'postgres', '-d', 'postgres'];
  if (opts.single) args.push('-1');
  for (const [k, v] of Object.entries(opts.vars ?? {})) args.push('-v', `${k}=${v}`);
  args.push('-f', opts.path ?? join(PACKET, file));
  const r = spawnSync(PSQL, args, { encoding: 'utf8', env: { ...process.env, PGPASSWORD: 'postgres', PGCONNECT_TIMEOUT: '10' } });
  if (r.error) throw new Error(`psql could not run (${PSQL}): ${r.error.message}`);
  const rec: Record<string, string> = {};
  for (const line of r.stdout.split('\n')) {
    const m = /^(\w+)\s+\| ?(.*)$/.exec(line);
    if (m) rec[m[1]] = m[2].trimEnd();
  }
  return { status: r.status, out: r.stdout, err: r.stderr, rec };
}
const apply = (vars?: Record<string, string>) => psql('apply.sql', { single: true, vars: vars ?? { expected_sysid: sysid } });
const recovery = () => psql('recovery.sql', { single: true, vars: { expected_sysid: sysid } });

async function state() {
  const { rows } = await db.query(`
    SELECT (SELECT count(*)::int FROM supabase_migrations.schema_migrations) AS ledger_rows,
           encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') AS body, proacl::text AS acl
      FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'get_players_overview'`);
  return rows[0] as { ledger_rows: number; body: string; acl: string };
}
async function asUser(uid: string, sql: string, params: unknown[] = []) {
  await db.query('BEGIN');
  try {
    await db.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [uid]);
    return (await db.query(sql, params)).rows;
  } finally {
    await db.query('ROLLBACK');
  }
}
const overview = (uid: string, academy: string, filters: object, limit = 50) =>
  asUser(uid, `SELECT full_name FROM public.get_players_overview('academy', $1, NULL, $2::jsonb, 'name', 'asc', $3, 0)`,
    [academy, JSON.stringify(filters), limit]);

beforeAll(async () => {
  await startServer();
  db = new Client({ connectionString: `postgresql://postgres:postgres@${HOST}:${PORT}/postgres` });
  await db.connect();
  sysid = (await db.query('SELECT system_identifier::text AS s FROM pg_control_system()')).rows[0].s;

  // Supabase roles, default function privileges and auth.uid() (claims-based, as the platform's).
  await db.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;`);
  await db.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
  await db.query(`
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $fn$;
    CREATE SCHEMA supabase_migrations;
    CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, statements text[], name text);`);

  // The overview's input tables (playersOverviewCurrentTraining.pglite.test.ts shape) + prod join indexes.
  await db.query(`
    CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY, timezone text);
    CREATE TABLE public.academy_managers (academy_profile_id uuid, user_id uuid);
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.academy_trainers (academy_profile_id uuid, trainer_profile_id uuid, status text);
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid, full_name text, email text, phone text,
      billing_business_name text, billing_address text, billing_btw_number text, skill_rating numeric, rating_system text, birth_date date);
    CREATE TABLE public.guest_players (id uuid PRIMARY KEY, trainer_id uuid, academy_profile_id uuid, full_name text, email text,
      phone text, billing_business_name text, billing_address text, billing_btw_number text, skill_rating numeric, rating_system text,
      notes text, source text, birth_date date, has_trained boolean, preferred_location_id uuid, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.persons (id uuid PRIMARY KEY, full_name text, email text, phone text, birth_date date, skill_rating numeric,
      rating_system text, user_id uuid, billing_business_name text, billing_address text, billing_btw_number text);
    CREATE TABLE public.person_links (person_id uuid, profile_id uuid, guest_player_id uuid);
    CREATE TABLE public.person_merge_review (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text, status text,
      guest_player_id uuid, person_id uuid, email text);
    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, trainer_id uuid, academy_profile_id uuid, location_id uuid,
      cyclus_id uuid, cyclus_name text, start_time timestamptz, end_time timestamptz, max_participants integer, is_public boolean,
      price_per_session numeric);
    CREATE TABLE public.bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, player_id uuid, guest_player_id uuid,
      person_id uuid, status text, payment_status text, paid_externally boolean, hold_expires_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.academy_player_metadata (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), academy_profile_id uuid,
      trainer_profile_id uuid, guest_player_id uuid, profile_id uuid, notes text, tag_ids uuid[], preferred_location_id uuid,
      removed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.intake_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), cycle_id uuid, player_id uuid,
      guest_player_id uuid, location_id uuid, status text);
    CREATE TABLE public.academy_player_locations (academy_profile_id uuid, profile_id uuid, guest_player_id uuid, location_id uuid, dismissed boolean);
    CREATE TABLE public.locations (id uuid PRIMARY KEY, name text, merged_into uuid);
    CREATE TABLE public.academy_locations (academy_profile_id uuid, location_id uuid, is_active boolean);
    CREATE TABLE public.invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), academy_profile_id uuid, trainer_id uuid,
      player_id uuid, guest_player_id uuid, status text, due_date date, paid_at timestamptz);
    CREATE TABLE public.email_address_state (email text, state text, provider_suppressed_active boolean NOT NULL DEFAULT false,
      is_suppressed boolean GENERATED ALWAYS AS ((state IN ('hard_bounced','complained')) OR provider_suppressed_active) STORED);
    CREATE TABLE public.cycles (id uuid PRIMARY KEY, name text, owner_type text, owner_id uuid, status text, type text,
      start_date date, end_date date, price_per_session numeric, location_id uuid, category_id uuid, settings jsonb);
    CREATE TABLE public.academy_cycle_categories (id uuid PRIMARY KEY, name text, color text);
    CREATE INDEX idx_bookings_slot_id ON public.bookings (slot_id);
    CREATE INDEX idx_bookings_guest_player_id ON public.bookings (guest_player_id);
    CREATE INDEX idx_bookings_player_id ON public.bookings (player_id);
    CREATE INDEX idx_availability_slots_trainer ON public.availability_slots (trainer_id);
    CREATE INDEX idx_availability_slots_academy ON public.availability_slots (academy_profile_id);
    CREATE INDEX idx_availability_slots_cyclus ON public.availability_slots (cyclus_id) WHERE cyclus_id IS NOT NULL;
    CREATE INDEX idx_availability_slots_location_id ON public.availability_slots (location_id);
    CREATE INDEX idx_guest_players_trainer ON public.guest_players (trainer_id);
    CREATE INDEX idx_guest_players_academy ON public.guest_players (academy_profile_id);
    CREATE INDEX idx_person_links_person ON public.person_links (person_id);
    CREATE INDEX idx_person_links_guest ON public.person_links (guest_player_id);
    CREATE INDEX idx_person_links_profile ON public.person_links (profile_id);
    CREATE INDEX idx_academy_player_metadata_academy ON public.academy_player_metadata (academy_profile_id);
    CREATE OR REPLACE FUNCTION public.is_academy_manager(_user_id uuid, _academy_profile_id uuid)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
        SELECT EXISTS (SELECT 1 FROM public.academy_managers WHERE user_id = _user_id AND academy_profile_id = _academy_profile_id) $fn$;
    CREATE OR REPLACE FUNCTION public.get_user_academy_ids(_u uuid) RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path = public AS $fn$ SELECT academy_profile_id FROM public.academy_managers WHERE user_id = _u $fn$;
    CREATE OR REPLACE FUNCTION public.fold_search_text(_value text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
      SET search_path = public AS $fn$ SELECT lower(coalesce(_value, '')) $fn$;
    CREATE OR REPLACE FUNCTION public.digits_only(_value text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
      SET search_path = public AS $fn$ SELECT regexp_replace(coalesce(_value, ''), '\\D', '', 'g') $fn$;
    CREATE OR REPLACE FUNCTION public.booking_occupies_seat(p_status text, p_hold_expires_at timestamptz) RETURNS boolean
      LANGUAGE sql STABLE AS $fn$ SELECT COALESCE(p_status, 'confirmed') IN ('confirmed', 'pending', 'pending_approval')
        OR (p_status = 'payment_pending' AND p_hold_expires_at IS NOT NULL AND p_hold_expires_at > now()) $fn$;`);

  // The canonical chain for get_players_overview, grants and all (as production applied it).
  for (const f of ['20260827100000_phase32_players_overview_person_dedup.sql', '20260901110000_phase33e_overview_type_has_login.sql',
    '20261006120000_readers_canonical_is_suppressed.sql']) {
    await db.query(MIG(f));
  }

  // The 620-version ledger: the repository's versions except PTF, plus the six F0 and the ACL version.
  const repo = readdirSync(join(process.cwd(), 'supabase', 'migrations'))
    .map((f) => /^(\d{14})_/.exec(f)?.[1]).filter((v): v is string => Boolean(v) && v !== '20261208100000');
  const versions = [...repo, ...F0_ACL_VERSIONS];
  expect(versions).toHaveLength(620);
  const sorted = [...versions].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  expect(createHash('sha256').update(sorted.join('\n')).digest('hex')).toBe(C_BASE);
  await db.query('INSERT INTO supabase_migrations.schema_migrations (version) SELECT unnest($1::text[])', [versions]);

  // Small behaviour fixture: academy A (manager MGR_A), academy B, a trainer at both.
  await db.query(`
    INSERT INTO public.academy_profiles (id) VALUES ('${A}'), ('${B}');
    INSERT INTO public.academy_managers VALUES ('${A}', '${MGR_A}'), ('${B}', '${MGR_B}');
    INSERT INTO public.trainer_profiles VALUES ('${TS}', gen_random_uuid());
    INSERT INTO public.academy_trainers VALUES ('${A}', '${TS}', 'active'), ('${B}', '${TS}', 'active');
    INSERT INTO public.locations (id, name) VALUES ('${LOC}', 'Club A');
    INSERT INTO public.availability_slots (id, trainer_id, academy_profile_id, location_id, cyclus_id, start_time, end_time) VALUES
      (gen_random_uuid(), '${TS}', '${A}', '${LOC}', '${CYC_ON}', now() - interval '7 days', now() - interval '7 days' + interval '1 hour'),
      ('5e100000-0000-0000-0000-000000000002', '${TS}', '${A}', '${LOC}', '${CYC_ON}', now() + interval '1 day', now() + interval '1 day 1 hour'),
      ('5e100000-0000-0000-0000-000000000003', '${TS}', '${A}', '${LOC}', '${CYC_FU}', now() + interval '3 days', now() + interval '3 days 1 hour');
    INSERT INTO public.guest_players (id, academy_profile_id, full_name, email) VALUES
      ('${G_ON}', '${A}', 'Ongoing Guest', 'on@x.nl'), ('${G_FU}', '${A}', 'Future Guest', 'fu@x.nl');
    INSERT INTO public.bookings (slot_id, guest_player_id, status) VALUES
      ('5e100000-0000-0000-0000-000000000002', '${G_ON}', 'confirmed'),
      ('5e100000-0000-0000-0000-000000000003', '${G_FU}', 'confirmed');`);
}, 180_000);

afterAll(async () => {
  for (const c of extraClients) { try { await c.end(); } catch { /* ignore */ } }
  try { await db?.end(); } catch { /* ignore */ }
  try { await stopServer(); } catch { /* ignore */ }
});

describe('PTF release packet on real PostgreSQL', () => {
  it('the harness reproduces the production baseline receipt exactly (preflight.sql)', async () => {
    const r = psql('preflight.sql');
    expect(r.status, r.err).toBe(0);
    expect(r.rec).toMatchObject({
      ledger_rows: '620', ledger_head: '20261207100000', ledger_is_reviewed_plus_acl: 't', versions_after_acl: '',
      fn_count: '1', fn_identity_args: ARGS, fn_language: 'plpgsql', fn_volatility: 's', fn_security_definer: 'true',
      fn_config: 'search_path=public', fn_owner: 'postgres', fn_acl: PROD_ACL, fn_body_sha256: BODY_LIVE, fn_body_bytes: '29903',
    });
  });

  it('the post-check fails before apply', () => {
    const r = psql('postcheck.sql');
    expect(r.status, r.err).toBe(0);
    expect(r.rec).toMatchObject({ ledger_ok: 'f', fn_body_ok: 'f' });
  });

  it('every guard refuses and changes nothing', async () => {
    const before = await state();
    const refused = (r: Psql, re: RegExp) => { expect(r.status).not.toBe(0); expect(r.err).toMatch(re); };

    refused(apply({}), /syntax error|expected_sysid/);                                  // no -v expected_sysid
    refused(apply({ expected_sysid: '123' }), /ptf apply guard: system identifier/);

    await db.query(`INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('20261209000000')`);
    refused(apply(), /ptf apply guard: the ledger is neither/);
    await db.query(`DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261209000000'`);

    await db.query('GRANT EXECUTE ON FUNCTION public.get_players_overview(text, uuid, text, jsonb, text, text, integer, integer) TO anon');
    refused(apply(), /ptf apply guard: get_players_overview privileges drifted/);
    await db.query('REVOKE EXECUTE ON FUNCTION public.get_players_overview(text, uuid, text, jsonb, text, text, integer, integer) FROM anon');

    // PTF body with the pre-PTF ledger (the migration run on its own): body and ledger disagree.
    expect(psql('', { path: join(process.cwd(), 'supabase', 'migrations', '20261208100000_players_overview_current_training.sql') }).status).toBe(0);
    refused(apply(), /ptf apply guard: ledger and function body disagree/);
    expect(psql('restore_canonical_get_players_overview.sql').status).toBe(0);

    // another migration run holds the ledger: apply's lock waits 5 s, then refuses
    const other = await newClient();
    await other.query('BEGIN; LOCK TABLE supabase_migrations.schema_migrations IN SHARE MODE');
    refused(apply(), /lock timeout/);
    await other.query('ROLLBACK');
    await other.end();

    expect(await state()).toEqual(before);
    expect(before).toMatchObject({ ledger_rows: 620, body: BODY_LIVE, acl: PROD_ACL });
  }, 60_000);

  it('apply does not wait on open reader transactions, and commits the exact end state', async () => {
    const reader = await newClient();
    await reader.query('BEGIN');
    await reader.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [MGR_A]);
    await reader.query(`SELECT count(*) FROM public.get_players_overview('academy', $1, NULL, '{}'::jsonb, 'name', 'asc', 50, 0)`, [A]);

    const t0 = Date.now();
    const r = apply();
    const elapsed = Date.now() - t0;
    expect(r.status, r.err).toBe(0);
    expect(r.out).toContain('INSERT 0 1');
    expect(r.err).toContain('ptf apply: get_players_overview body');
    expect(elapsed).toBeLessThan(5000); // not blocked by the idle reader transaction

    // The reader's already-open transaction keeps working without error (it may still run the old body
    // until it processes the catalogue invalidation); a NEW transaction runs the new body.
    const during = await reader.query(`SELECT full_name FROM public.get_players_overview('academy', $1, NULL, '{"current_training": true}'::jsonb, 'name', 'asc', 50, 0)`, [A]);
    expect(during.rows.length).toBeGreaterThan(0);
    await reader.query('COMMIT');
    await reader.query('BEGIN');
    await reader.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [MGR_A]);
    const fresh = await reader.query(`SELECT full_name FROM public.get_players_overview('academy', $1, NULL, '{"current_training": true}'::jsonb, 'name', 'asc', 50, 0)`, [A]);
    expect(fresh.rows.map((x) => x.full_name)).toEqual(['Ongoing Guest']);
    await reader.query('COMMIT');
    await reader.end();

    expect(await state()).toEqual({ ledger_rows: 621, body: BODY_PTF, acl: PROD_ACL });
  }, 60_000);

  it('the post-check passes after apply, and its probe refuses a foreign caller', () => {
    const r = psql('postcheck.sql');
    expect(r.status, r.err).toBe(0);
    expect(r.rec).toMatchObject({
      ledger_rows: '621', ledger_head: '20261208100000', ledger_ok: 't', fn_single_ok: 't', fn_signature_ok: 't',
      fn_attributes_ok: 't', fn_privileges_ok: 't', fn_body_ok: 't', fn_body_sha256: BODY_PTF, fn_body_bytes: '33379',
      fn_acl: PROD_ACL, foreign_access: 'refused: not authorized', prepared_xacts: '0', in_flight: '',
    });
  });

  it('the composed function behaves (option A, tenant refusal) on real PostgreSQL', async () => {
    expect((await overview(MGR_A, A, { current_training: true })).map((x) => x.full_name)).toEqual(['Ongoing Guest']);
    expect((await overview(MGR_A, A, { current_training: false })).map((x) => x.full_name)).toEqual(['Future Guest']);
    expect((await overview(MGR_A, A, { training_location_id: LOC })).map((x) => x.full_name)).toEqual(['Ongoing Guest']);
    await expect(overview(MGR_B, A, { current_training: true })).rejects.toThrow(/not authorized for academy/);
  });

  it('a re-run of apply is a no-op', async () => {
    const r = apply();
    expect(r.status, r.err).toBe(0);
    expect(r.out).toContain('INSERT 0 0');
    expect(await state()).toEqual({ ledger_rows: 621, body: BODY_PTF, acl: PROD_ACL });
  });

  it('a representative performance observation stays within the budget', async () => {
    // One large academy (P): 2,000 guests; 20 cycles x 12 weekly sessions (10 ongoing, 10 not yet
    // started) + 80 standalone sessions (half past, half ahead); ~20,000 bookings over all four statuses;
    // academy B shares the trainer and adds 200 sessions of noise.
    const P = 'd1000000-0000-0000-0000-00000000000d';
    const MGR_P = 'd1000000-0000-0000-0000-0000000000d1';
    await db.query(`
      INSERT INTO public.academy_profiles (id) VALUES ('${P}');
      INSERT INTO public.academy_managers VALUES ('${P}', '${MGR_P}');
      INSERT INTO public.academy_trainers VALUES ('${P}', '${TS}', 'active');
      INSERT INTO public.guest_players (id, academy_profile_id, full_name, email)
        SELECT gen_random_uuid(), '${P}', 'Perf ' || g, 'perf' || g || '@x.nl' FROM generate_series(1, 2000) g;
      INSERT INTO public.availability_slots (id, trainer_id, academy_profile_id, location_id, cyclus_id, start_time, end_time)
        SELECT gen_random_uuid(), '${TS}'::uuid, '${P}'::uuid, '${LOC}'::uuid, md5('cyc' || c)::uuid,
               now() + ((s - 6 + (c % 2) * 7) * interval '7 days'), now() + ((s - 6 + (c % 2) * 7) * interval '7 days') + interval '1 hour'
          FROM generate_series(1, 20) c, generate_series(1, 12) s
        UNION ALL
        SELECT gen_random_uuid(), '${TS}'::uuid, '${P}'::uuid, '${LOC}'::uuid, NULL::uuid, now() + (s * interval '3 days') - interval '120 days',
               now() + (s * interval '3 days') - interval '120 days' + interval '1 hour' FROM generate_series(1, 80) s;
      INSERT INTO public.bookings (slot_id, guest_player_id, status)
        SELECT s.id, g.id, (ARRAY['confirmed','completed','cancelled','pending'])[1 + (abs(hashtext(g.id::text || s.id::text)) % 4)]
          FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM public.guest_players WHERE academy_profile_id = '${P}') g
          JOIN (SELECT id, row_number() OVER (ORDER BY id) AS n FROM public.availability_slots WHERE academy_profile_id = '${P}') s
            ON s.n % 32 = g.n % 32;
      INSERT INTO public.availability_slots (id, trainer_id, academy_profile_id, location_id, start_time, end_time)
        SELECT gen_random_uuid(), '${TS}', '${B}', '${LOC}', now() + g * interval '1 day', now() + g * interval '1 day' + interval '1 hour'
          FROM generate_series(1, 200) g;
      ANALYZE;`);
    const bookings = (await db.query(`SELECT count(*)::int AS n FROM public.bookings b JOIN public.availability_slots s ON s.id = b.slot_id WHERE s.academy_profile_id = '${P}'`)).rows[0].n;
    expect(bookings).toBeGreaterThan(15_000);

    const time = async (filters: object, limit: number) => {
      const ms: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t = performance.now();
        await overview(MGR_P, P, filters, limit);
        ms.push(performance.now() - t);
      }
      return ms.sort((x, y) => x - y)[2]; // median of 5
    };
    const unfiltered50 = await time({}, 50);
    const training50 = await time({ current_training: true }, 50);
    const training500 = await time({ current_training: true }, 500);
    const club500 = await time({ training_location_id: LOC }, 500);
    console.log(`PTF perf (median of 5, ms): unfiltered/50=${unfiltered50.toFixed(0)} training/50=${training50.toFixed(0)} `
      + `training/500=${training500.toFixed(0)} club/500=${club500.toFixed(0)} bookings=${bookings}`);
    // Budget: the training filters may cost at most 50% + 100 ms over the unfiltered page, and no export
    // page (500 rows) may exceed 2 s on this fixture.
    expect(training50).toBeLessThanOrEqual(unfiltered50 * 1.5 + 100);
    expect(training500).toBeLessThanOrEqual(2000);
    expect(club500).toBeLessThanOrEqual(2000);
  }, 180_000);

  it('forward recovery restores the canonical body exactly; a re-run is a no-op; apply then refuses', async () => {
    const r = recovery();
    expect(r.status, r.err).toBe(0);
    expect(r.out).toContain('INSERT 0 1');
    expect(await state()).toEqual({ ledger_rows: 622, body: BODY_LIVE, acl: PROD_ACL });
    const ledger = (await db.query(`SELECT encode(sha256(convert_to(string_agg(version, E'\\n' ORDER BY version COLLATE "C"), 'UTF8')), 'hex') AS d FROM supabase_migrations.schema_migrations`)).rows[0].d;
    expect(ledger).toBe(C_RESTORED);
    // the restored body is the canonical one: the new keys are gone again, has_active_cyclus still works
    await expect(overview(MGR_A, A, { current_training: true })).resolves.toHaveLength(2);

    const again = recovery();
    expect(again.status, again.err).toBe(0);
    expect(again.out).toContain('INSERT 0 0');

    const reapply = apply();
    expect(reapply.status).not.toBe(0);
    expect(reapply.err).toMatch(/ptf apply guard: the ledger is neither/);
    expect(await state()).toEqual({ ledger_rows: 622, body: BODY_LIVE, acl: PROD_ACL });
  }, 60_000);

  it('the packet constants are the ones this suite derives', () => {
    for (const f of ['apply.sql', 'recovery.sql', 'postcheck.sql']) {
      const text = readFileSync(join(PACKET, f), 'utf8');
      for (const c of [C_PTF, BODY_PTF]) expect(text).toContain(c);
    }
    expect(readFileSync(join(PACKET, 'apply.sql'), 'utf8')).toContain(C_BASE);
    expect(readFileSync(join(PACKET, 'recovery.sql'), 'utf8')).toContain(C_RESTORED);
  });
});
