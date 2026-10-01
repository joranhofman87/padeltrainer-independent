// @vitest-environment node
// PTF release packet (docs/deployment/ptf-release) on a REAL PostgreSQL server, driven by real psql.
//
// Harness: the functions' production shape — Supabase's roles and default privileges (schema-scoped AND
// global, the worst case for a new schema and new functions), the overview's input tables (same shape as
// playersOverviewCurrentTraining.pglite.test.ts), the canonical migration chain for get_players_overview,
// and a ledger holding exactly the 620 versions production records after the ACL correction (the
// repository's versions minus PTF, plus the six F0 versions and the ACL version). F0/ACL touch neither
// these functions nor the tables they read (release-prep record).
//
// Proves: the harness reproduces the production baseline receipt and the BASE object state; every apply
// guard refuses and changes nothing (ledger, sysid, every object attribute, stray objects, DDL in flight);
// apply does not wait on app reads, DML or autovacuum-strength locks; apply → the exact PTF object state;
// the post-check passes only after apply and both refusal probes refuse; no client role reaches the private
// authority and the export runs for authenticated only; the composed functions behave (A1 + E1); ONE
// export call reads ONE snapshot even when another session commits mid-call (with VOLATILE controls that
// show the proof discriminates); re-run is a no-op; forward recovery returns the exact BASE state; and a
// representative performance observation. PTF_MEASURE=1 adds the decision packet's §3 20,000-person run.
//
// Server: embedded PostgreSQL by default; PTF_PGBIN=<dir with initdb, pg_ctl, postgres> runs the same
// suite on other binaries (production is 17.6). psql: PTF_PSQL, else `psql` on PATH.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { Client } = pg;
const PORT = 54391;
const HOST = '127.0.0.1';
const PSQL = process.env.PTF_PSQL ?? 'psql';
const PGBIN = process.env.PTF_PGBIN;
const PACKET = join(process.cwd(), 'docs', 'deployment', 'ptf-release');
const MIGRATION = '20261208100000_players_overview_current_training.sql';
const MIG = (f: string) => readFileSync(join(process.cwd(), 'supabase', 'migrations', f), 'utf8');
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const C_BASE = '98015eddaccd8ef67297c172db67495f5ff11a881ea28e1f024fb82741c3bc72';
const C_PTF = '901dc2c86de75066075c12e9da19e277d372da66c31b84433911b0e3cc07f900';
const C_RESTORED = 'b312bf6a1dcc0fbc35c9f2c24e7f947daaf1d312b422534003deeb8ed90b302e';
const BODY_LIVE = '0f42f53cab95b897e10ee0295f9185de15056a0cd904252c84bb117e0b7003f4';
const PROD_ACL = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}';
const ARGS = 'p_scope text, p_scope_id uuid, p_search text, p_filters jsonb, p_sort text, p_sort_dir text, p_limit integer, p_offset integer';
const F0_ACL_VERSIONS = ['20261204100000', '20261204110000', '20261205100000', '20261206100000',
  '20261206110000', '20261206120000', '20261207100000'];

// ── The expected object states, built from the receipt's values and the reviewed migration's bodies ──
const LIST_RESULT = 'TABLE(player_key text, player_type text, guest_player_id uuid, profile_id uuid, person_id uuid, '
  + 'full_name text, email text, phone text, billing_business_name text, billing_address text, billing_btw_number text, '
  + 'skill_rating numeric, rating_system text, notes text, source text, birth_date date, has_trained boolean, '
  + 'created_at timestamp with time zone, owner_trainer_id uuid, metadata_id uuid, tag_ids uuid[], academy_notes text, '
  + 'trainer_ids uuid[], location_ids uuid[], location_names text[], has_active_cyclus boolean, has_overdue_payment boolean, '
  + 'email_undeliverable boolean, total_count bigint)';
const LIST_ACL = 'authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres';
/** The stored body (prosrc) of `name` in a migration text: everything between `AS $$` and the closing `$$;`. */
function bodyOf(src: string, name: string): string {
  const at = src.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  if (at < 0) throw new Error(`no ${name} in the migration`);
  const open = src.indexOf('AS $$', at) + 'AS $$'.length;
  return src.slice(open, src.indexOf('\n$$;', open) + 1);
}
/**
 * One descriptor line, in the canonical format of docs/deployment/ptf-release/state_descriptor.sql.
 * Every function this release touches is plpgsql, owned by postgres, STABLE, not STRICT, set-returning,
 * not LEAKPROOF, PARALLEL UNSAFE and without a support function — those are fixed here; the rest varies.
 */
const fnLine = (sig: string, args: string, result: string, secdef: 't' | 'f', config: string, acl: string, body: string) =>
  `function ${sig} args=(${args}) returns ${result} kind=f owner=postgres language=plpgsql volatility=s strict=f `
  + `returns_set=t security_definer=${secdef} leakproof=f parallel=u support=- config=${config} acl=${acl} body_sha256=${body}`;
const PTF_SRC = MIG(MIGRATION);
const PINNED = 'search_path=pg_catalog, pg_temp';
const BODY_AUTHORITY = sha256(bodyOf(PTF_SRC, 'players_private.players_overview_rows'));
const BODY_LIST = sha256(bodyOf(PTF_SRC, 'public.get_players_overview'));
const BODY_EXPORT = sha256(bodyOf(PTF_SRC, 'public.get_players_overview_export'));
// Full arguments with defaults (pg_get_function_arguments), as the list's CREATE statement declares them.
const LIST_ARGS_DEFAULTS = "p_scope text, p_scope_id uuid, p_search text DEFAULT NULL::text, p_filters jsonb DEFAULT '{}'::jsonb, "
  + "p_sort text DEFAULT 'name'::text, p_sort_dir text DEFAULT 'asc'::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0";
const EXPORT_IDENTITY = 'p_academy uuid, p_search text, p_filters jsonb, p_sort text, p_sort_dir text';
const EXPORT_ARGS_DEFAULTS = "p_academy uuid, p_search text DEFAULT NULL::text, p_filters jsonb DEFAULT '{}'::jsonb, "
  + "p_sort text DEFAULT 'name'::text, p_sort_dir text DEFAULT 'asc'::text";
const AUTHORITY_ARGS = `${ARGS}, p_enrich boolean`;
const BASE_STATE = fnLine(`public.get_players_overview(${ARGS})`, LIST_ARGS_DEFAULTS, LIST_RESULT, 't', 'search_path=public', LIST_ACL, BODY_LIVE);
const PTF_STATE = [
  fnLine(`players_private.players_overview_rows(${AUTHORITY_ARGS})`, AUTHORITY_ARGS, LIST_RESULT.replace(/\)$/, ', sort_ord bigint)'),
    'f', PINNED, 'postgres=X/postgres', BODY_AUTHORITY),
  fnLine(`public.get_players_overview(${ARGS})`, LIST_ARGS_DEFAULTS, LIST_RESULT, 't', PINNED, LIST_ACL, BODY_LIST),
  fnLine(`public.get_players_overview_export(${EXPORT_IDENTITY})`, EXPORT_ARGS_DEFAULTS,
    'TABLE(total bigint, rows jsonb)', 't', PINNED, 'authenticated=X/postgres,postgres=X/postgres', BODY_EXPORT),
  'schema players_private owner=postgres acl=postgres=UC/postgres relations=0 types=0',
].join('\n');
const C_STATE_BASE = '24b71348940111025c9353b339b5eb8ce4b041922575e4dd9b8f900fa7f84d0b';
const C_STATE_PTF = 'ca0d9b031804fb8a5d9f5858b6d5959af0343ac7f8fc3d3efcea0539e435d5dc';
const AUTHORITY_SIG = 'players_private.players_overview_rows(text, uuid, text, jsonb, text, text, integer, integer, boolean)';
const LIST_SIG = 'public.get_players_overview(text, uuid, text, jsonb, text, text, integer, integer)';
const EXPORT_SIG = 'public.get_players_overview_export(uuid, text, jsonb, text, text)';

/** A marked block of a packet file (the STATE DESCRIPTOR or the IN-FLIGHT PROBE), exactly as written. */
function blocks(file: string, marker: string): string[] {
  const text = readFileSync(join(PACKET, file), 'utf8');
  const out: string[] = [];
  let at = 0;
  for (;;) {
    const b = text.indexOf(`-- ${marker} BEGIN`, at);
    if (b < 0) return out;
    const e = text.indexOf(`-- ${marker} END`, b);
    out.push(text.slice(b, e));
    at = e;
  }
}
/** The CANONICAL descriptor (state_descriptor.sql); the six embedded copies must equal it. */
const DESCRIPTOR_SQL = blocks('state_descriptor.sql', 'STATE DESCRIPTOR')[0];

// fixture ids (small behaviour fixture)
const A = 'a1000000-0000-0000-0000-00000000000a';
const B = 'b1000000-0000-0000-0000-00000000000b';
const MGR_A = 'a1000000-0000-0000-0000-0000000000a1';
const MGR_B = 'b1000000-0000-0000-0000-0000000000b1';
const TS = 'c1000000-0000-0000-0000-000000000071';
const LOC = 'a1000000-0000-0000-0000-00000000e0a1';
const CYC_ON = 'cc100000-0000-0000-0000-0000000000c1';
const CYC_FU = 'cc100000-0000-0000-0000-0000000000c2';
// A1 preservation (Tom, 2026-09-29): the academy id the capture and repair pin, with its own trainer, manager and
// 34 trainer-owned manual guests (2 academy-invoiced, 1 linked to a canonical person).
const RA = 'f5124b05-6c8b-40e4-9d67-36e2a41acd36';
const MGR_RA = 'f5000000-0000-0000-0000-0000000000a1';
const TR = 'f5000000-0000-0000-0000-000000000071';
const P_R = 'f5000000-0000-0000-0000-0000000000e1';
const PR_X = 'f5000000-0000-0000-0000-0000000000f1'; // another side (a profile) of P_R, for the person-wide refusals
const RG = (i: number) => `f5${String(i).padStart(6, '0')}-0000-4000-8000-000000000000`;
const RG_IDS = Array.from({ length: 34 }, (_, i) => RG(i + 1)).sort();
const RG_NAME = (k: number) => `Preserve ${String(k).padStart(2, '0')}`;
const RB3 = 'f5000000-0000-0000-0000-00000000000b';   // another academy: sentinel rows that must never change
const S_RB3 = 'f5000000-0000-0000-0000-0000000005b3';
const EQ = (n: number) => `f6${String(n).padStart(6, '0')}-0000-4000-8000-000000000000`; // the classification's own fixture
const G_ON = '9a100000-0000-0000-0000-000000000001';
const G_FU = '9a100000-0000-0000-0000-000000000002';
const G_T = '9a100000-0000-0000-0000-000000000003';   // TS's own guest: no academy, no A booking
const P_B = '9b100000-0000-0000-0000-000000000004';   // a profile booked only on B's session of TS
const S_B = '5e100000-0000-0000-0000-000000000004';

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
let canonicalAList: string[] = [];

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
// A1 preservation repair: the committed file carries the two PINNING DELTA constants — NULL (the refusing template)
// or, after the reviewed pinning delta, CAPTURE's digest and person count. The suite normalizes it back to the
// template and derives fixture-pinned copies by exact substitution of those two lines only.
const PIN_SHA = /^ {2}c_pinned_sha256 {5}CONSTANT text {4}:= (NULL|'[0-9a-f]{64}');( {2}-- PINNING DELTA: CAP's pinned_sha256)$/m;
const PIN_PERSONS = /^ {2}c_effective_persons CONSTANT integer := (NULL|[1-9][0-9]?);( {2}-- PINNING DELTA: CAP's effective_persons)$/m;
const REPAIR_COMMITTED = () => readFileSync(join(PACKET, 'a1_preserve_repair.sql'), 'utf8');
const pinRepair = (sha: string | null, persons: number | null) =>
  REPAIR_COMMITTED()
    .replace(PIN_SHA, (_m, _v, tail) => `  c_pinned_sha256     CONSTANT text    := ${sha === null ? 'NULL' : `'${sha}'`};${tail}`)
    .replace(PIN_PERSONS, (_m, _v, tail) => `  c_effective_persons CONSTANT integer := ${persons === null ? 'NULL' : persons};${tail}`);
let repairDir = '';
const repairFile = (text: string) => {
  repairDir ||= mkdtempSync(join(tmpdir(), 'ptf-a1p-'));
  const f = join(repairDir, `repair-${Math.random().toString(36).slice(2)}.sql`);
  writeFileSync(f, text);
  return f;
};
// The operator's only input channel: the ids as ONE psql variable (a quoted literal), never an executed file.
const preserve = (file: string, ids: string, sysidVar?: string) =>
  psql('', { single: true, path: file, vars: { expected_sysid: sysidVar ?? sysid, pinned_ids: ids } });
const recovery = () => psql('recovery.sql', { single: true, vars: { expected_sysid: sysid } });

async function state() {
  const { rows } = await db.query(`SELECT (SELECT count(*)::int FROM supabase_migrations.schema_migrations) AS ledger_rows,
    (${DESCRIPTOR_SQL}) AS descriptor`);
  const { ledger_rows, descriptor } = rows[0] as { ledger_rows: number; descriptor: string };
  return { ledger_rows, digest: sha256(descriptor), descriptor };
}
async function asUser(uid: string, sql: string, params: unknown[] = [], role?: string) {
  await db.query('BEGIN');
  try {
    if (role) await db.query(`SET LOCAL ROLE ${role}`);
    await db.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [uid]);
    return (await db.query(sql, params)).rows;
  } finally {
    await db.query('ROLLBACK');
  }
}
const overview = (uid: string, academy: string, filters: object, limit = 50) =>
  asUser(uid, `SELECT full_name FROM public.get_players_overview('academy', $1, NULL, $2::jsonb, 'name', 'asc', $3, 0)`,
    [academy, JSON.stringify(filters), limit]);
const exportCall = async (uid: string, academy: string, filters: object = {}) => {
  const [row] = await asUser(uid, `SELECT total, rows FROM public.get_players_overview_export($1, NULL, $2::jsonb, 'name', 'asc')`,
    [academy, JSON.stringify(filters)]);
  return { total: Number(row.total), rows: row.rows as Array<{ person_id: string; full_name: string; email: string; phone: string }> };
};
const names = (rows: Array<{ full_name: string }>) => rows.map((x) => x.full_name);

beforeAll(async () => {
  await startServer();
  db = new Client({ connectionString: `postgresql://postgres:postgres@${HOST}:${PORT}/postgres` });
  await db.connect();
  sysid = (await db.query('SELECT system_identifier::text AS s FROM pg_control_system()')).rows[0].s;

  // Supabase roles, schema-scoped default function privileges (as the platform's) and auth.uid()
  // (claims-based, as the platform's). Global defaults follow the canonical chain below.
  await db.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE ROLE ptf_other;`);
  await db.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
  await db.query(`
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $fn$;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
    CREATE SCHEMA supabase_migrations;
    CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, statements text[], name text);`);

  // The overview's input tables (playersOverviewCurrentTraining.pglite.test.ts shape) + prod join indexes.
  await db.query(`
    CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY, timezone text);
    CREATE TABLE public.academy_managers (academy_profile_id uuid, user_id uuid);
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.academy_trainers (academy_profile_id uuid, trainer_profile_id uuid, status text, joined_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid, full_name text, email text, phone text,
      billing_business_name text, billing_address text, billing_btw_number text, skill_rating numeric, rating_system text, birth_date date);
    CREATE TABLE public.guest_players (id uuid PRIMARY KEY, trainer_id uuid, academy_profile_id uuid, full_name text, email text,
      phone text, billing_business_name text, billing_address text, billing_btw_number text, skill_rating numeric, rating_system text,
      notes text, source text, birth_date date, has_trained boolean, preferred_location_id uuid, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.persons (id uuid PRIMARY KEY, full_name text, email text, phone text, birth_date date, skill_rating numeric,
      rating_system text, user_id uuid, billing_business_name text, billing_address text, billing_btw_number text);
    -- production's identity-map keys (20260826260000): one source per link, each source linked once
    CREATE TABLE public.person_links (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), person_id uuid NOT NULL,
      profile_id uuid UNIQUE, guest_player_id uuid UNIQUE, created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT person_links_exactly_one_source CHECK ((profile_id IS NOT NULL)::int + (guest_player_id IS NOT NULL)::int = 1));
    CREATE TABLE public.person_merge_review (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text, status text,
      guest_player_id uuid, person_id uuid, email text);
    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, trainer_id uuid, academy_profile_id uuid, location_id uuid,
      cyclus_id uuid, cyclus_name text, start_time timestamptz, end_time timestamptz, max_participants integer, is_public boolean,
      price_per_session numeric);
    CREATE TABLE public.bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, player_id uuid, guest_player_id uuid,
      person_id uuid, status text, payment_status text, paid_externally boolean, hold_expires_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.academy_player_metadata (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), academy_profile_id uuid,
      trainer_profile_id uuid, guest_player_id uuid, profile_id uuid, notes text, tag_ids uuid[] NOT NULL DEFAULT '{}',
      preferred_location_id uuid, removed_at timestamptz, person_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT academy_player_metadata_owner_check
        CHECK ((academy_profile_id IS NOT NULL)::int + (trainer_profile_id IS NOT NULL)::int = 1),
      CONSTRAINT academy_player_metadata_subject_check
        CHECK ((guest_player_id IS NOT NULL AND profile_id IS NULL) OR (guest_player_id IS NULL AND profile_id IS NOT NULL)));
    -- production's relationship keys (20260510090036 / 20260510102923)
    CREATE UNIQUE INDEX idx_academy_player_metadata_guest ON public.academy_player_metadata (academy_profile_id, guest_player_id)
      WHERE guest_player_id IS NOT NULL;
    CREATE UNIQUE INDEX idx_academy_player_metadata_profile ON public.academy_player_metadata (academy_profile_id, profile_id)
      WHERE profile_id IS NOT NULL;
    CREATE UNIQUE INDEX idx_academy_player_metadata_trainer_guest ON public.academy_player_metadata (trainer_profile_id, guest_player_id)
      WHERE trainer_profile_id IS NOT NULL AND guest_player_id IS NOT NULL;
    CREATE UNIQUE INDEX idx_academy_player_metadata_trainer_profile ON public.academy_player_metadata (trainer_profile_id, profile_id)
      WHERE trainer_profile_id IS NOT NULL AND profile_id IS NOT NULL;
    CREATE TABLE public.slot_priority_claims (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, source_slot_id uuid,
      guest_player_id uuid, booked_by_guest_player_id uuid);
    CREATE TABLE public.notification_contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), guest_player_id uuid,
      consent_academy_profile_id uuid);
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

  // production's person stamp on the relationship table (20260826260000_persons_expand.sql, verbatim body)
  await db.query(`
    CREATE OR REPLACE FUNCTION public.stamp_person_id_academy_player_metadata() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
    BEGIN
      IF NEW.profile_id IS NOT NULL OR NEW.guest_player_id IS NOT NULL
         OR (TG_OP = 'UPDATE' AND (OLD.profile_id IS NOT NULL OR OLD.guest_player_id IS NOT NULL)) THEN
        NEW.person_id := COALESCE(
          (SELECT pl.person_id FROM public.person_links pl WHERE pl.guest_player_id = NEW.guest_player_id),
          (SELECT pl.person_id FROM public.person_links pl WHERE pl.profile_id = NEW.profile_id)
        );
      END IF;
      RETURN NEW;
    END;
    $fn$;
    CREATE TRIGGER trg_stamp_person_id_academy_player_metadata
      BEFORE INSERT OR UPDATE OF profile_id, guest_player_id, person_id ON public.academy_player_metadata
      FOR EACH ROW EXECUTE FUNCTION public.stamp_person_id_academy_player_metadata();`);

  // The canonical chain for get_players_overview, grants and all (as production applied it).
  for (const f of ['20260827100000_phase32_players_overview_person_dedup.sql', '20260901110000_phase33e_overview_type_has_login.sql',
    '20261006120000_readers_canonical_is_suppressed.sql']) {
    await db.query(MIG(f));
  }
  // The worst case for what PTF CREATES: global defaults that would hand every new schema and function
  // to the client roles. The migration's explicit REVOKEs must win against them.
  await db.query(`ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES GRANT USAGE ON SCHEMAS TO anon, authenticated, service_role;`);

  // The 620-version ledger: the repository's versions except PTF (and the later export follow-up
  // 20261208120000, which applies after PTF), plus the six F0 and the ACL version.
  const LATER_THAN_BASE = new Set(['20261208100000', '20261208120000']);
  const repo = readdirSync(join(process.cwd(), 'supabase', 'migrations'))
    .map((f) => /^(\d{14})_/.exec(f)?.[1]).filter((v): v is string => Boolean(v) && !LATER_THAN_BASE.has(v));
  const versions = [...repo, ...F0_ACL_VERSIONS];
  expect(versions).toHaveLength(620);
  const sorted = [...versions].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  expect(createHash('sha256').update(sorted.join('\n')).digest('hex')).toBe(C_BASE);
  await db.query('INSERT INTO supabase_migrations.schema_migrations (version) SELECT unnest($1::text[])', [versions]);

  // Small behaviour fixture: academy A (manager MGR_A), academy B, a trainer at both with its own practice.
  await db.query(`
    INSERT INTO public.academy_profiles (id) VALUES ('${A}'), ('${B}');
    INSERT INTO public.academy_managers VALUES ('${A}', '${MGR_A}'), ('${B}', '${MGR_B}');
    INSERT INTO public.trainer_profiles VALUES ('${TS}', gen_random_uuid());
    INSERT INTO public.academy_trainers VALUES ('${A}', '${TS}', 'active'), ('${B}', '${TS}', 'active');
    INSERT INTO public.locations (id, name) VALUES ('${LOC}', 'Club A');
    INSERT INTO public.availability_slots (id, trainer_id, academy_profile_id, location_id, cyclus_id, start_time, end_time) VALUES
      (gen_random_uuid(), '${TS}', '${A}', '${LOC}', '${CYC_ON}', now() - interval '7 days', now() - interval '7 days' + interval '1 hour'),
      ('5e100000-0000-0000-0000-000000000002', '${TS}', '${A}', '${LOC}', '${CYC_ON}', now() + interval '1 day', now() + interval '1 day 1 hour'),
      ('5e100000-0000-0000-0000-000000000003', '${TS}', '${A}', '${LOC}', '${CYC_FU}', now() + interval '3 days', now() + interval '3 days 1 hour'),
      ('${S_B}', '${TS}', '${B}', NULL, NULL, now() - interval '2 days', now() - interval '2 days' + interval '1 hour');
    INSERT INTO public.guest_players (id, academy_profile_id, trainer_id, full_name, email) VALUES
      ('${G_ON}', '${A}', NULL, 'Ongoing Guest', 'on@x.nl'), ('${G_FU}', '${A}', NULL, 'Future Guest', 'fu@x.nl'),
      ('${G_T}', NULL, '${TS}', 'Trainer Own Guest', 'own@x.nl');
    INSERT INTO public.profiles (id, full_name, email) VALUES ('${P_B}', 'B Slot Profile', 'bslot@x.nl');
    INSERT INTO public.bookings (slot_id, guest_player_id, player_id, status) VALUES
      ('5e100000-0000-0000-0000-000000000002', '${G_ON}', NULL, 'confirmed'),
      ('5e100000-0000-0000-0000-000000000003', '${G_FU}', NULL, 'confirmed'),
      ('${S_B}', NULL, '${P_B}', 'completed');`);
}, 180_000);

afterAll(async () => {
  for (const c of extraClients) { try { await c.end(); } catch { /* ignore */ } }
  try { await db?.end(); } catch { /* ignore */ }
  try { await stopServer(); } catch { /* ignore */ }
});

describe('PTF release packet on real PostgreSQL', () => {
  it('the harness reproduces the production baseline receipt exactly, and the BASE object state', async () => {
    const r = psql('preflight.sql');
    expect(r.status, r.err).toBe(0);
    expect(r.rec).toMatchObject({
      ledger_rows: '620', ledger_head: '20261207100000', ledger_is_reviewed_plus_acl: 't', versions_after_acl: '',
      fn_count: '1', fn_identity_args: ARGS, fn_result: LIST_RESULT, fn_language: 'plpgsql', fn_volatility: 's',
      fn_security_definer: 'true', fn_config: 'search_path=public', fn_owner: 'postgres', fn_acl: PROD_ACL,
      fn_body_sha256: BODY_LIVE, fn_body_bytes: '29903',
    });
    const s = await state();
    expect(s.descriptor).toBe(BASE_STATE);
    expect(s.digest).toBe(C_STATE_BASE);
    expect(sha256(BASE_STATE)).toBe(C_STATE_BASE);
    expect(sha256(PTF_STATE)).toBe(C_STATE_PTF);
    // the canonical universe: the shared trainer's other sessions and own guests leak into A (what A1 closes)
    canonicalAList = names(await overview(MGR_A, A, {}));
    expect(canonicalAList).toEqual(['B Slot Profile', 'Future Guest', 'Ongoing Guest', 'Trainer Own Guest']);
  });

  it('the post-check fails before apply', () => {
    const r = psql('postcheck.sql');
    expect(r.status, r.err).toBe(0);
    expect(r.rec).toMatchObject({ ledger_ok: 'f', state_ok: 'f', client_roles_ok: 'f' });
  });

  it('every guard refuses and changes nothing', async () => {
    const before = await state();
    const refused = (r: Psql, re: RegExp) => { expect(r.status).not.toBe(0); expect(r.err).toMatch(re); };
    const STATE = /ptf apply guard: the object state is not the one this ledger expects/;

    refused(apply({}), /syntax error|expected_sysid/);                                  // no -v expected_sysid
    refused(apply({ expected_sysid: '123' }), /ptf apply guard: system identifier/);

    await db.query(`INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('20261209000000')`);
    refused(apply(), /ptf apply guard: the ledger is neither/);
    await db.query(`DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261209000000'`);

    // P2-1 / P2-4: every behaviour- or authority-affecting attribute of the live function is part of the
    // state — privileges, owner, config, volatility, SECURITY DEFINER, strictness, parallel safety,
    // leakproof, and the argument defaults — and each drift refuses on its own.
    const canonical = readFileSync(join(PACKET, 'restore_canonical_get_players_overview.sql'), 'utf8');
    const withLimitDefault = (n: number) => canonical.replace('p_limit integer DEFAULT 50,', `p_limit integer DEFAULT ${n},`);
    expect(withLimitDefault(10)).not.toBe(canonical);
    for (const [drift, undo] of [
      [`GRANT EXECUTE ON FUNCTION ${LIST_SIG} TO anon`, `REVOKE EXECUTE ON FUNCTION ${LIST_SIG} FROM anon`],
      [`ALTER FUNCTION ${LIST_SIG} OWNER TO ptf_other`, `ALTER FUNCTION ${LIST_SIG} OWNER TO postgres`],
      [`ALTER FUNCTION ${LIST_SIG} SET search_path = public, pg_temp`, `ALTER FUNCTION ${LIST_SIG} SET search_path = public`],
      [`ALTER FUNCTION ${LIST_SIG} VOLATILE`, `ALTER FUNCTION ${LIST_SIG} STABLE`],
      [`ALTER FUNCTION ${LIST_SIG} SECURITY INVOKER`, `ALTER FUNCTION ${LIST_SIG} SECURITY DEFINER`],
      [`ALTER FUNCTION ${LIST_SIG} STRICT`, `ALTER FUNCTION ${LIST_SIG} CALLED ON NULL INPUT`],
      [`ALTER FUNCTION ${LIST_SIG} PARALLEL SAFE`, `ALTER FUNCTION ${LIST_SIG} PARALLEL UNSAFE`],
      [`ALTER FUNCTION ${LIST_SIG} LEAKPROOF`, `ALTER FUNCTION ${LIST_SIG} NOT LEAKPROOF`],
      [withLimitDefault(10), canonical], // a changed argument default: same signature, same body
      // stray objects this release would otherwise adopt
      ['CREATE SCHEMA players_private', 'DROP SCHEMA players_private'],
      [`CREATE FUNCTION public.get_players_overview_export(uuid) RETURNS int LANGUAGE sql AS 'SELECT 1'`,
        'DROP FUNCTION public.get_players_overview_export(uuid)'],
    ]) {
      await db.query(drift);
      refused(apply(), STATE);
      await db.query(undo);
      expect(await state(), drift).toEqual(before);
    }

    // The PTF migration run on its own (outside apply): PTF objects with the pre-PTF ledger.
    expect(psql('', { path: join(process.cwd(), 'supabase', 'migrations', MIGRATION) }).status).toBe(0);
    refused(apply(), STATE);
    expect(psql('restore_canonical_get_players_overview.sql').status).toBe(0);
    await db.query(`DROP FUNCTION ${EXPORT_SIG}; DROP FUNCTION ${AUTHORITY_SIG}; DROP SCHEMA players_private;`);

    // P2-2: DDL in flight in another session — a DDL-strength table lock, an uncommitted ALTER TABLE,
    // a lock on the function itself, and a relation being created in schema public (the schema lock
    // that relation creation takes; creating a FUNCTION takes none) — each refuses.
    const busy = /ptf apply guard: other migration or DDL work is in flight/;
    for (const [sql, what] of [
      ['LOCK TABLE public.bookings IN SHARE MODE', /ShareLock on relation (public\.)?bookings/],
      ['ALTER TABLE public.guest_players ADD COLUMN ptf_probe int', /AccessExclusiveLock on relation (public\.)?guest_players/],
      [`DROP FUNCTION ${LIST_SIG}`, /AccessExclusiveLock on function (public\.)?get_players_overview\(/],
      ['CREATE TABLE public.ptf_probe (x int)', /AccessShareLock on schema public/],
    ] as const) {
      const other = await newClient();
      try {
        await other.query('BEGIN');
        await other.query(sql);
        const r = apply();
        refused(r, busy);
        expect(r.err).toMatch(what);
      } finally {
        await other.query('ROLLBACK');
        await other.end();
      }
    }

    // another migration run holds the ledger: apply's lock waits 5 s, then refuses
    const other = await newClient();
    await other.query('BEGIN; LOCK TABLE supabase_migrations.schema_migrations IN SHARE MODE');
    refused(apply(), /lock timeout/);
    await other.query('ROLLBACK');
    await other.end();

    // recovery refuses a database that never received PTF
    const rec = recovery();
    expect(rec.status).not.toBe(0);
    expect(rec.err).toMatch(/ptf recovery guard: the ledger is neither/);

    expect(await state()).toEqual(before);
    expect(before).toMatchObject({ ledger_rows: 620, digest: C_STATE_BASE });
  }, 120_000);

  it('A1 preservation (pre-apply): the bounded capture classifies as the validated classification; the repair refuses unpinned, malformed or contradicted input; the pinned first run links the set once; the replay is a no-op', async () => {
    const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
    const capture = () => {
      const r = psql('a1_preserve_capture.sql');
      expect(r.status, r.err).toBe(0);
      expect(r.out).toContain('ROLLBACK');
      return r.rec;
    };
    await db.query(`INSERT INTO public.academy_profiles (id) VALUES ('${RA}');
      INSERT INTO public.academy_managers VALUES ('${RA}', '${MGR_RA}');`);

    // (1) R-4: the classification's own hand-worked fixture (PGlite receipt ptf-a1-cls-dryrun-…d31229e9, PASS), for this
    //     academy. The capture, whose booking evidence is now bounded to the academy's sessions and the dropped guests,
    //     must classify it exactly as the validated classification did.
    const T1 = 'f6000000-0000-0000-0000-000000000071', T2 = 'f6000000-0000-0000-0000-000000000072';
    const T3 = 'f6000000-0000-0000-0000-000000000073', T4 = 'f6000000-0000-0000-0000-000000000074';
    const B2 = 'f6000000-0000-0000-0000-00000000000b', CYA = 'f6000000-0000-0000-0000-0000000000c1';
    const SA1 = 'f6000000-0000-0000-0000-00000000a001', SA2 = 'f6000000-0000-0000-0000-00000000a002';
    const SB1 = 'f6000000-0000-0000-0000-00000000b001', SU1 = 'f6000000-0000-0000-0000-00000000c001';
    const PR2 = 'f6000000-0000-0000-0000-0000000000e2', PR9 = 'f6000000-0000-0000-0000-0000000000e9';
    const P1 = 'f6000000-0000-0000-0000-0000000000f1', P2 = 'f6000000-0000-0000-0000-0000000000f2';
    const eqIds = [...Array.from({ length: 18 }, (_, i) => EQ(i + 1)), ...Array.from({ length: 8 }, (_, i) => EQ(i + 20))];
    const eqList = eqIds.map((id) => `'${id}'`).join(', ');
    await db.query(`
      INSERT INTO public.academy_profiles (id) VALUES ('${B2}');
      INSERT INTO public.academy_trainers (academy_profile_id, trainer_profile_id, status, joined_at) VALUES
        ('${RA}', '${T1}', 'active', '2026-03-01'), ('${RA}', '${T2}', 'active', '2026-01-01'),
        ('${B2}', '${T2}', 'active', '2026-01-01'), ('${RA}', '${T3}', 'removed', '2026-01-01');
      INSERT INTO public.availability_slots (id, trainer_id, academy_profile_id) VALUES
        ('${SA1}', '${T1}', '${RA}'), ('${SA2}', '${T2}', '${RA}'), ('${SB1}', '${T2}', '${B2}'), ('${SU1}', '${T4}', NULL);
      INSERT INTO public.cycles (id, owner_type, owner_id) VALUES ('${CYA}', 'academy', '${RA}');
      INSERT INTO public.guest_players (id, trainer_id, academy_profile_id, full_name, source, created_at) VALUES
        ('${EQ(1)}', '${T1}', NULL, 'EQ 1', 'manual', '2026-06-01'), ('${EQ(2)}', '${T2}', NULL, 'EQ 2', 'manual', '2026-06-01'),
        ('${EQ(3)}', '${T2}', '${B2}', 'EQ 3', 'manual', '2026-06-01'), ('${EQ(4)}', '${T1}', NULL, 'EQ 4', 'manual', '2026-06-01'),
        ('${EQ(5)}', '${T1}', NULL, 'EQ 5', 'manual', '2026-06-01'), ('${EQ(6)}', '${T1}', NULL, 'EQ 6', 'intake', '2026-06-01'),
        ('${EQ(7)}', '${T1}', NULL, 'EQ 7', 'manual', '2026-06-01'), ('${EQ(8)}', '${T1}', NULL, 'EQ 8', 'manual', '2026-06-01'),
        ('${EQ(9)}', '${T1}', NULL, 'EQ 9', 'manual', '2026-06-01'), ('${EQ(10)}', '${T2}', NULL, 'EQ 10', 'manual', '2026-06-01'),
        ('${EQ(11)}', '${T2}', NULL, 'EQ 11', 'manual', '2026-06-01'), ('${EQ(12)}', '${T1}', NULL, 'EQ 12', 'invoice_backfill', '2026-06-01'),
        ('${EQ(13)}', '${T1}', NULL, 'EQ 13', 'manual', '2026-06-01'), ('${EQ(14)}', '${T1}', NULL, 'EQ 14', 'manual', '2025-12-01'),
        ('${EQ(15)}', '${T1}', NULL, 'EQ 15', NULL, '2026-06-01'), ('${EQ(16)}', '${T1}', NULL, 'EQ 16', 'Jan Jansen via WhatsApp', '2026-06-01'),
        ('${EQ(17)}', '${T1}', NULL, 'EQ 17', 'manual', '2026-06-01'),
        ('${EQ(18)}', NULL, '${RA}', 'EQ 18', 'manual', '2026-06-01'), ('${EQ(20)}', '${T1}', '${RA}', 'EQ 20', 'manual', '2026-06-01'),
        ('${EQ(21)}', '${T1}', NULL, 'EQ 21', 'manual', '2026-06-01'), ('${EQ(22)}', '${T1}', NULL, 'EQ 22', 'manual', '2026-06-01'),
        ('${EQ(23)}', '${T1}', NULL, 'EQ 23', 'manual', '2026-06-01'), ('${EQ(24)}', '${T3}', NULL, 'EQ 24', 'manual', '2026-06-01'),
        ('${EQ(25)}', '${T4}', NULL, 'EQ 25', 'manual', '2026-06-01'), ('${EQ(26)}', NULL, '${B2}', 'EQ 26', 'manual', '2026-06-01'),
        ('${EQ(27)}', '${T4}', NULL, 'EQ 27', 'manual', '2026-06-01');
      INSERT INTO public.profiles (id, full_name) VALUES ('${PR2}', 'EQ profile 2'), ('${PR9}', 'EQ profile 9');
      INSERT INTO public.persons (id, full_name) VALUES ('${P1}', 'EQ 1'), ('${P2}', 'EQ 2');
      INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${P1}', '${EQ(1)}'), ('${P1}', '${EQ(18)}'), ('${P2}', '${EQ(2)}');
      INSERT INTO public.person_links (person_id, profile_id) VALUES ('${P2}', '${PR2}');
      INSERT INTO public.bookings (slot_id, guest_player_id, player_id, status) VALUES
        ('${SA1}', NULL, '${PR2}', 'confirmed'), ('${SA1}', '${EQ(8)}', NULL, 'pending'), ('${SB1}', '${EQ(10)}', NULL, 'confirmed'),
        ('${SB1}', '${EQ(11)}', NULL, 'completed'), ('${SU1}', '${EQ(13)}', NULL, 'confirmed'), ('${SB1}', '${EQ(17)}', NULL, 'cancelled'),
        ('${SA2}', '${EQ(21)}', NULL, 'completed'), ('${SA1}', '${EQ(27)}', NULL, 'confirmed'), ('${SA1}', NULL, '${PR9}', 'cancelled');
      INSERT INTO public.academy_player_metadata (academy_profile_id, guest_player_id, removed_at) VALUES
        ('${RA}', '${EQ(22)}', NULL), ('${RA}', '${EQ(23)}', '2026-07-01');
      INSERT INTO public.invoices (academy_profile_id, trainer_id, guest_player_id) VALUES
        ('${RA}', NULL, '${EQ(1)}'), ('${RA}', NULL, '${EQ(4)}'), ('${RA}', NULL, '${EQ(10)}'),
        (NULL, '${T2}', '${EQ(11)}'), (NULL, '${T1}', '${EQ(12)}');
      INSERT INTO public.academy_player_locations (academy_profile_id, guest_player_id) VALUES ('${RA}', '${EQ(3)}'), ('${RA}', '${EQ(5)}');
      INSERT INTO public.intake_requests (cycle_id, guest_player_id) VALUES ('${CYA}', '${EQ(6)}');
      INSERT INTO public.slot_priority_claims (slot_id, source_slot_id, guest_player_id) VALUES ('${SA2}', '${SA1}', '${EQ(7)}');
      INSERT INTO public.notification_contacts (guest_player_id, consent_academy_profile_id) VALUES ('${EQ(9)}', '${RA}');`);
    // The receipt's exact category counts (2/1/7/1/3/2/1 over 17), its academy-invoice signal (3), its origins (13 manual).
    // The capture's combined "other academy signal" is the 6 guests with a location, intake, claim, other-status booking or
    // consent; the 17 dropped sides are 17 canonical persons (EQ 1 and EQ 2 each key as their person).
    expect(capture()).toMatchObject({
      pinned_count: '17', effective_persons: '17',
      cat1_person_still_listed: '2', cat2_other_academy_owned: '1', cat3_academy_signal: '7', cat4_trained_other_academy: '1',
      cat5_trainer_private: '3', cat6_no_booking_no_signal: '2', cat7_other: '1',
      signal_academy_invoice: '3', signal_other_academy_signal: '6', origin_manual: '13',
      refuse_person_removed_side: '0', refuse_other_side_metadata: '0',
    });
    await db.query(`
      DELETE FROM public.bookings WHERE slot_id IN ('${SA1}', '${SA2}', '${SB1}', '${SU1}');
      DELETE FROM public.availability_slots WHERE id IN ('${SA1}', '${SA2}', '${SB1}', '${SU1}');
      DELETE FROM public.slot_priority_claims WHERE guest_player_id = '${EQ(7)}';
      DELETE FROM public.notification_contacts WHERE guest_player_id = '${EQ(9)}';
      DELETE FROM public.intake_requests WHERE cycle_id = '${CYA}';
      DELETE FROM public.cycles WHERE id = '${CYA}';
      DELETE FROM public.academy_player_locations WHERE academy_profile_id = '${RA}';
      DELETE FROM public.invoices WHERE guest_player_id IN (${eqList});
      DELETE FROM public.academy_player_metadata WHERE guest_player_id IN (${eqList});
      DELETE FROM public.person_links WHERE person_id IN ('${P1}', '${P2}');
      DELETE FROM public.persons WHERE id IN ('${P1}', '${P2}');
      DELETE FROM public.profiles WHERE id IN ('${PR2}', '${PR9}');
      DELETE FROM public.guest_players WHERE id IN (${eqList});
      DELETE FROM public.academy_trainers WHERE trainer_profile_id IN ('${T1}', '${T2}', '${T3}');
      DELETE FROM public.academy_profiles WHERE id = '${B2}';`);
    expect(capture()).toMatchObject({ pinned_count: '0' });

    // (2) The decided set: 34 trainer-owned manual guests, 2 academy-invoiced; two of them are sides of ONE person (R-3);
    //     sentinels that must never change: a cancelled booking and a relationship row at another academy.
    await db.query(`
      INSERT INTO public.trainer_profiles VALUES ('${TR}', gen_random_uuid());
      INSERT INTO public.academy_trainers (academy_profile_id, trainer_profile_id, status, joined_at)
        VALUES ('${RA}', '${TR}', 'active', now() - interval '1 year');
      INSERT INTO public.guest_players (id, trainer_id, full_name, source, created_at) VALUES
        ${RG_IDS.map((id, k) => `('${id}', '${TR}', '${RG_NAME(k + 1)}', 'manual', now() - interval '1 day')`).join(', ')};
      INSERT INTO public.invoices (academy_profile_id, guest_player_id, status) VALUES
        ('${RA}', '${RG_IDS[0]}', 'paid'), ('${RA}', '${RG_IDS[1]}', 'sent');
      INSERT INTO public.persons (id, full_name) VALUES ('${P_R}', '${RG_NAME(3)}');
      INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${P_R}', '${RG_IDS[2]}'), ('${P_R}', '${RG_IDS[3]}');
      INSERT INTO public.academy_profiles (id) VALUES ('${RB3}');
      INSERT INTO public.availability_slots (id, trainer_id, academy_profile_id) VALUES ('${S_RB3}', '${TR}', '${RB3}');
      INSERT INTO public.bookings (slot_id, guest_player_id, status) VALUES ('${S_RB3}', '${RG_IDS[0]}', 'cancelled');
      INSERT INTO public.academy_player_metadata (academy_profile_id, guest_player_id, notes)
        VALUES ('${RB3}', '${RG_IDS[10]}', 'sentinel');`);

    // CAP: exactly the 34, classified as decided, 33 canonical persons, nothing refused.
    const pinnedIds = `{${RG_IDS.join(',')}}`;
    const pinnedSha = sha256(RG_IDS.join(','));
    expect(capture()).toMatchObject({
      pinned_count: '34', effective_persons: '33', pinned_sha256: pinnedSha, pinned_ids: pinnedIds,
      cat1_person_still_listed: '0', cat2_other_academy_owned: '0', cat3_academy_signal: '2', cat4_trained_other_academy: '0',
      cat5_trainer_private: '0', cat6_no_booking_no_signal: '32', cat7_other: '0', signal_academy_invoice: '2',
      signal_other_academy_signal: '0', origin_manual: '34', refuse_person_removed_side: '0', refuse_other_side_metadata: '0',
    });

    // The committed repair carries exactly one of each PINNING DELTA line. The template (both NULL) and the
    // fixture-pinned copy differ in exactly those two lines.
    const committed = REPAIR_COMMITTED();
    expect(committed.match(new RegExp(PIN_SHA.source, 'gm'))).toHaveLength(1);
    expect(committed.match(new RegExp(PIN_PERSONS.source, 'gm'))).toHaveLength(1);
    const templateText = pinRepair(null, null);
    const pinnedText = pinRepair(pinnedSha, 33);
    expect(pinnedText.split('\n').filter((line, i) => line !== templateText.split('\n')[i])).toHaveLength(2);
    const template = repairFile(templateText);
    const pinned = repairFile(pinnedText);

    // Everything the repair must preserve, as exact row images.
    const snapshot = async () => one(`SELECT
      (SELECT md5(coalesce(string_agg(row_to_json(m)::text, '|' ORDER BY m.id), '')) FROM public.academy_player_metadata m
        WHERE m.academy_profile_id = $1) AS relationships,
      (SELECT count(*)::int FROM public.academy_player_metadata m WHERE m.academy_profile_id = $1) AS relationship_rows,
      (SELECT md5(coalesce(string_agg(row_to_json(m)::text, '|' ORDER BY m.id), '')) FROM public.academy_player_metadata m
        WHERE m.guest_player_id = ANY ($2::uuid[]) AND m.academy_profile_id IS DISTINCT FROM $1) AS other_academies,
      (SELECT md5(coalesce(string_agg(row_to_json(g)::text, '|' ORDER BY g.id), '')) FROM public.guest_players g
        WHERE g.id = ANY ($2::uuid[])) AS guests,
      (SELECT md5(coalesce(string_agg(row_to_json(i)::text, '|' ORDER BY i.id), '')) FROM public.invoices i
        WHERE i.guest_player_id = ANY ($2::uuid[])) AS invoices,
      (SELECT md5(coalesce(string_agg(row_to_json(b)::text, '|' ORDER BY b.id), '')) FROM public.bookings b
        WHERE b.guest_player_id = ANY ($2::uuid[])) AS bookings,
      (SELECT md5(coalesce(string_agg(row_to_json(pl)::text, '|' ORDER BY pl.id), '')) FROM public.person_links pl
        WHERE pl.person_id = $3 OR pl.guest_player_id = ANY ($2::uuid[])) AS person_links,
      (SELECT count(*)::int FROM supabase_migrations.schema_migrations) AS ledger_rows`, [RA, RG_IDS, P_R]);
    const base = await snapshot();
    expect(base.relationship_rows).toBe(0);
    const refused = async (r: Psql, re: RegExp, expected: Record<string, unknown> | null = base) => {
      expect(r.status, r.out).not.toBe(0);
      expect(r.err).toMatch(re);
      if (expected) expect(await snapshot()).toEqual(expected);
    };

    // Unpinned: the committed template refuses even the right ids.
    await refused(preserve(template, pinnedIds), /ptf a1 preserve guard: the capture digest is not pinned in this reviewed file/);
    await refused(preserve(pinned, pinnedIds, '1'), /ptf a1 preserve guard: system identifier/);

    // The one input channel is a quoted literal through one canonical parser: nothing in it executes.
    const upper = pinnedIds.replace(RG_IDS[0], RG_IDS[0].toUpperCase());
    for (const bad of ['', '{}', pinnedIds.slice(1, -1), pinnedIds.replace(/,/g, ', '), upper,
      `{${RG_IDS.slice(0, 33).join(',')},NULL}`, `${pinnedIds}'); DELETE FROM public.invoices; --`,
      `${pinnedIds};DELETE FROM public.invoices`]) {
      await refused(preserve(pinned, bad), /ptf a1 preserve guard: pinned_ids is not a canonical id list/);
    }
    const swapped = [...RG_IDS];
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    await refused(preserve(pinned, `{${swapped.join(',')}}`), /ptf a1 preserve guard: pinned_ids is not sorted and distinct/);
    await refused(preserve(pinned, `{${[RG_IDS[0], ...RG_IDS].join(',')}}`), /ptf a1 preserve guard: pinned_ids is not sorted and distinct/);
    await refused(preserve(pinned, `{${RG_IDS.slice(1).join(',')}}`), /ptf a1 preserve guard: the pinned set must be 34 ids \(got 33\)/);
    // R-2: a different canonical 34-set never matches the pinned digest (first run here, replay below).
    const other34 = [...RG_IDS.slice(1), RG(99)].sort();
    await refused(preserve(pinned, `{${other34.join(',')}}`), /ptf a1 preserve guard: the pinned ids hash to [0-9a-f]{64}, not to the digest pinned in this file/);

    // Contradictions (each made, refused, then reverted; the images then equal the baseline again).
    const settles = async () => expect(await snapshot()).toEqual(base);
    await db.query(`INSERT INTO public.guest_players (id, trainer_id, full_name, source) VALUES ('${RG(99)}', '${TR}', 'Preserve new', 'manual')`);
    await refused(preserve(pinned, pinnedIds), /not the academy's current A1-dropped set \(35 dropped now, 34 pinned\)/);
    await db.query(`DELETE FROM public.guest_players WHERE id = '${RG(99)}'`);
    await settles();
    await db.query(`UPDATE public.guest_players SET academy_profile_id = '${RB3}' WHERE id = '${RG_IDS[4]}'`);
    await refused(preserve(pinned, pinnedIds), /refused, 1 owned by an academy, 0 not owned/, null);
    await db.query(`UPDATE public.guest_players SET academy_profile_id = NULL WHERE id = '${RG_IDS[4]}'`);
    await db.query(`UPDATE public.guest_players SET trainer_id = '${TS}' WHERE id = '${RG_IDS[5]}'`);
    await refused(preserve(pinned, pinnedIds), /0 owned by an academy, 1 not owned by an active trainer of this academy/, null);
    await db.query(`UPDATE public.guest_players SET trainer_id = '${TR}' WHERE id = '${RG_IDS[5]}'`);
    await settles();
    // person-wide: a removed profile side of the person, then an already-related profile side, then a related GUEST side
    await db.query(`
      INSERT INTO public.profiles (id, full_name) VALUES ('${PR_X}', 'Preserve profile side');
      INSERT INTO public.person_links (person_id, profile_id) VALUES ('${P_R}', '${PR_X}');
      INSERT INTO public.academy_player_metadata (academy_profile_id, profile_id, removed_at) VALUES ('${RA}', '${PR_X}', now());`);
    await refused(preserve(pinned, pinnedIds), /2 with a removed side here, 0 with another side/, null);
    await db.query(`UPDATE public.academy_player_metadata SET removed_at = NULL WHERE profile_id = '${PR_X}'`);
    await refused(preserve(pinned, pinnedIds), /0 with a removed side here, 2 with another side already related here/, null);
    await db.query(`
      DELETE FROM public.academy_player_metadata WHERE profile_id = '${PR_X}';
      DELETE FROM public.person_links WHERE profile_id = '${PR_X}';
      DELETE FROM public.profiles WHERE id = '${PR_X}';
      INSERT INTO public.guest_players (id, trainer_id, full_name, source) VALUES ('${RG(98)}', '${TR}', 'Preserve side', 'manual');
      INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${P_R}', '${RG(98)}');
      INSERT INTO public.academy_player_metadata (academy_profile_id, guest_player_id) VALUES ('${RA}', '${RG(98)}');`);
    await refused(preserve(pinned, pinnedIds), /0 with a removed side here, 2 with another side already related here/, null);
    await db.query(`
      DELETE FROM public.academy_player_metadata WHERE guest_player_id = '${RG(98)}';
      DELETE FROM public.person_links WHERE guest_player_id = '${RG(98)}';
      DELETE FROM public.guest_players WHERE id = '${RG(98)}';`);
    await settles();
    // an earlier partial run
    await db.query(`INSERT INTO public.academy_player_metadata (academy_profile_id, guest_player_id) VALUES ('${RA}', '${RG_IDS[6]}')`);
    await refused(preserve(pinned, pinnedIds), /mixed state, 1 of 34 pinned guests already related here/, null);
    await db.query(`DELETE FROM public.academy_player_metadata WHERE guest_player_id = '${RG_IDS[6]}'`);
    await settles();
    // R-3: the pinned persons moved since CAP (a third side joins the person), or a side is split-frozen (keys as itself)
    await db.query(`INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${P_R}', '${RG_IDS[5]}')`);
    await refused(preserve(pinned, pinnedIds), /the pinned guests form 32 canonical persons, the pinned count is 33/, null);
    await db.query(`DELETE FROM public.person_links WHERE guest_player_id = '${RG_IDS[5]}'`);
    await db.query(`INSERT INTO public.person_merge_review (kind, status, guest_player_id)
      VALUES ('twin_detached_needs_split', 'pending', '${RG_IDS[3]}')`);
    await refused(preserve(pinned, pinnedIds), /the pinned guests form 34 canonical persons, the pinned count is 33/);
    await db.query(`DELETE FROM public.person_merge_review WHERE guest_player_id = '${RG_IDS[3]}'`);
    await settles();

    // FIRST RUN: exactly the 34 rows, the canonical person stamped, only the relationship rows changed.
    const first = preserve(pinned, pinnedIds);
    expect(first.status, first.err).toBe(0);
    expect(first.out).toContain('inputs loaded');
    expect(first.err).toContain(
      `ptf a1 preserve: inserted 34, linked 34/34 for academy ${RA}, pinned ${pinnedSha}, effective persons 33, dropped now 0`);
    const rows = (await db.query(`SELECT guest_player_id::text AS g, person_id::text AS p,
        (notes IS NULL AND cardinality(tag_ids) = 0 AND removed_at IS NULL AND trainer_profile_id IS NULL AND profile_id IS NULL) AS clean
        FROM public.academy_player_metadata WHERE academy_profile_id = $1 ORDER BY guest_player_id`, [RA])).rows;
    expect(rows.map((r) => r.g)).toEqual(RG_IDS);
    expect(rows.every((r) => r.clean)).toBe(true);
    expect(rows.filter((r) => r.p !== null).map((r) => [r.g, r.p])).toEqual([[RG_IDS[2], P_R], [RG_IDS[3], P_R]]);
    const afterFirst = await snapshot();
    expect(afterFirst.relationship_rows).toBe(34);
    expect({ ...afterFirst, relationships: base.relationships, relationship_rows: base.relationship_rows }).toEqual(base);
    expect(await state()).toMatchObject({ ledger_rows: 620, digest: C_STATE_BASE });

    // RE-RUN: a no-op success; the relationship rows are byte-identical; a different 34-set is refused (R-2).
    const again = preserve(pinned, pinnedIds);
    expect(again.status, again.err).toBe(0);
    expect(again.err).toContain(`ptf a1 preserve: inserted 0, linked 34/34 for academy ${RA}, pinned ${pinnedSha}, effective persons 33`);
    expect(await snapshot()).toEqual(afterFirst);
    await refused(preserve(pinned, `{${other34.join(',')}}`), /not to the digest pinned in this file/, afterFirst);
    await refused(preserve(template, pinnedIds), /the capture digest is not pinned in this reviewed file/, afterFirst);

    // CV: nothing of the academy is dropped any more.
    expect(capture()).toMatchObject({ pinned_count: '0', effective_persons: '0', pinned_ids: '{}', pinned_sha256: sha256('') });
  }, 180_000);

  it('apply does not wait on app reads, DML or autovacuum-strength locks, and commits the exact PTF state', async () => {
    const reader = await newClient();
    await reader.query('BEGIN');
    await reader.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [MGR_A]);
    await reader.query(`SELECT count(*) FROM public.get_players_overview('academy', $1, NULL, '{}'::jsonb, 'name', 'asc', 50, 0)`, [A]);
    const writer = await newClient();          // uncommitted DML: RowExclusive on bookings
    await writer.query('BEGIN');
    await writer.query(`INSERT INTO public.bookings (slot_id, status) VALUES (gen_random_uuid(), 'pending')`);
    const vacuumish = await newClient();       // what autovacuum / ANALYZE hold: ShareUpdateExclusive
    await vacuumish.query('BEGIN; LOCK TABLE public.guest_players IN SHARE UPDATE EXCLUSIVE MODE');

    let r: Psql;
    let elapsed: number;
    try {
      const t0 = Date.now();
      r = apply();
      elapsed = Date.now() - t0;
    } finally {
      await writer.query('ROLLBACK');
      await vacuumish.query('ROLLBACK');
    }
    expect(r.status, r.err).toBe(0);
    expect(r.out).toContain('INSERT 0 1');
    expect(r.err).toContain(`ptf apply: object state ${C_STATE_PTF}`);
    expect(elapsed).toBeLessThan(5000); // not blocked by any of them

    // The reader's already-open transaction keeps working without error; a NEW transaction runs the new body.
    const during = await reader.query(`SELECT full_name FROM public.get_players_overview('academy', $1, NULL, '{"current_training": true}'::jsonb, 'name', 'asc', 50, 0)`, [A]);
    expect(during.rows.length).toBeGreaterThan(0);
    await reader.query('COMMIT');
    await reader.query('BEGIN');
    await reader.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [MGR_A]);
    const fresh = await reader.query(`SELECT full_name FROM public.get_players_overview('academy', $1, NULL, '{"current_training": true}'::jsonb, 'name', 'asc', 50, 0)`, [A]);
    expect(fresh.rows.map((x) => x.full_name)).toEqual(['Ongoing Guest']);
    await reader.query('COMMIT');
    for (const c of [reader, writer, vacuumish]) await c.end();

    const s = await state();
    expect(s.descriptor).toBe(PTF_STATE);
    expect(s).toMatchObject({ ledger_rows: 621, digest: C_STATE_PTF });
  }, 60_000);

  it('the post-check passes after apply, and both refusal probes refuse a foreign caller', () => {
    const r = psql('postcheck.sql');
    expect(r.status, r.err).toBe(0);
    expect(r.rec).toMatchObject({
      ledger_rows: '621', ledger_head: '20261208100000', ledger_ok: 't', state_ok: 't', state_sha256: C_STATE_PTF,
      client_roles_ok: 't', foreign_access: 'refused: not authorized', foreign_export: 'refused: not authorized',
      prepared_xacts: '0', in_flight: '',
    });
    for (const line of PTF_STATE.split('\n')) expect(r.out).toContain(line);
  });

  it('after apply, the 34 preserved guests render as their 33 canonical persons (two pinned sides are one person); the repair then refuses', async () => {
    const listed = names(await overview(MGR_RA, RA, {}, 100));
    expect(listed).toHaveLength(33);
    for (let k = 1; k <= 34; k++) if (k !== 4) expect(listed).toContain(RG_NAME(k));
    // Preserve 03 and 04 are one person: one row, named by A1's scoped rule (oldest admitted side; a created_at tie → lower id)
    expect(listed).not.toContain(RG_NAME(4));
    const late = preserve(repairFile(pinRepair(sha256(RG_IDS.join(',')), 33)), `{${RG_IDS.join(',')}}`);
    expect(late.status).not.toBe(0);
    expect(late.err).toMatch(/ptf a1 preserve guard: the ledger is not the reviewed 620 versions .*runs before apply.sql only/);
  });

  it('no client role reaches the private authority; the export runs for authenticated only', async () => {
    const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string; message?: string }) => `${e.code} ${e.message}`);
    const authority = `SELECT * FROM ${AUTHORITY_SIG.replace(/\(.*/, '')}('academy', '${A}', NULL, '{}'::jsonb, 'name', 'asc', 10, 0, true)`;
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(await code(asUser(MGR_A, authority, [], role))).toMatch(/^42501 permission denied for schema players_private/);
    }
    const exp = `SELECT total FROM public.get_players_overview_export('${A}', NULL, '{}'::jsonb, 'name', 'asc')`;
    expect(await code(asUser(MGR_A, exp, [], 'authenticated'))).toBe('ok');
    for (const role of ['anon', 'service_role']) {
      expect(await code(asUser(MGR_A, exp, [], role))).toMatch(/^42501 permission denied for function get_players_overview_export/);
    }
    const list = `SELECT count(*) FROM public.get_players_overview('academy', '${A}', NULL, '{}'::jsonb, 'name', 'asc', 50, 0)`;
    expect(await code(asUser(MGR_A, list, [], 'authenticated'))).toBe('ok'); // the definer reaches the authority
    expect(await code(asUser(MGR_A, list, [], 'anon'))).toMatch(/^42501 permission denied for function get_players_overview/);
  });

  it('the composed functions behave on real PostgreSQL (option A, A1, E1, tenant refusal)', async () => {
    expect(names(await overview(MGR_A, A, { current_training: true }))).toEqual(['Ongoing Guest']);
    expect(names(await overview(MGR_A, A, { current_training: false }))).toEqual(['Future Guest']);
    expect(names(await overview(MGR_A, A, { training_location_id: LOC }))).toEqual(['Ongoing Guest']);
    // A1: the shared trainer's B session and own guest no longer reach A
    expect(names(await overview(MGR_A, A, {}))).toEqual(['Future Guest', 'Ongoing Guest']);
    expect(names(await overview(MGR_B, B, {}))).toEqual(['B Slot Profile']);
    // E1: one call, the list's rows and order
    const exp = await exportCall(MGR_A, A);
    expect(exp.total).toBe(2);
    expect(exp.rows.map((x) => x.full_name)).toEqual(['Future Guest', 'Ongoing Guest']);
    await expect(overview(MGR_B, A, { current_training: true })).rejects.toThrow(/not authorized for academy/);
    await expect(exportCall(MGR_B, A)).rejects.toThrow(/not authorized for academy/);
  });

  it('ONE export call reads ONE snapshot: a commit made mid-call is invisible to it (STABLE chain)', async () => {
    // The caller's statement takes its snapshot, then waits on a table the chain reads LATER (a lock held by
    // a second session, which meanwhile adds an A guest and commits). A STABLE chain keeps the statement's
    // snapshot, so the call cannot see that guest; the next call does.
    const midCall = async (blockTable: string, guestName: string) => {
      const caller = await newClient();
      const blocker = await newClient();
      await caller.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [MGR_A]);
      const pid = (await caller.query('SELECT pg_backend_pid() AS p')).rows[0].p as number;
      await blocker.query(`SET lock_timeout = '10s'`); // a leftover session lock fails fast instead of hanging
      await blocker.query('BEGIN');
      await blocker.query(`INSERT INTO public.guest_players (id, academy_profile_id, full_name) VALUES (gen_random_uuid(), $1, $2)`, [A, guestName]);
      await blocker.query(`LOCK TABLE ${blockTable} IN ACCESS EXCLUSIVE MODE`);
      const call = caller.query(`SELECT total, rows FROM public.get_players_overview_export($1, NULL, '{}'::jsonb, 'name', 'asc')`, [A]);
      const deadline = Date.now() + 10_000; // bounded: the call must reach the blocked table
      for (;;) {
        const { rows } = await db.query('SELECT count(*)::int AS n FROM pg_locks WHERE pid = $1 AND NOT granted', [pid]);
        if (rows[0].n > 0) break;
        if (Date.now() > deadline) throw new Error(`the export call never waited on ${blockTable}`);
        await new Promise((r) => setTimeout(r, 20));
      }
      await blocker.query('COMMIT');
      const { total, rows } = (await call).rows[0] as { total: string; rows: Array<{ full_name: string }> };
      const next = (await caller.query(`SELECT rows FROM public.get_players_overview_export($1, NULL, '{}'::jsonb, 'name', 'asc')`, [A])).rows[0].rows as Array<{ full_name: string }>;
      await caller.end();
      await blocker.end();
      return { total: Number(total), seen: names(rows), next: names(next) };
    };

    // Two wait points: the entry's own authorization read, and the authority's main statement.
    for (const table of ['public.academy_managers', 'public.academy_player_metadata']) {
      const guest = `Mid Call ${table}`;
      const r = await midCall(table, guest);
      expect(r.seen, table).not.toContain(guest);
      expect(r.total, table).toBe(r.seen.length);
      expect(r.next, table).toContain(guest);
    }

    // Controls — the proof discriminates: make one link VOLATILE and the same commit becomes visible.
    await db.query(`ALTER FUNCTION ${AUTHORITY_SIG} VOLATILE`);
    expect((await midCall('public.academy_player_metadata', 'Control Authority')).seen).toContain('Control Authority');
    await db.query(`ALTER FUNCTION ${AUTHORITY_SIG} STABLE`);
    await db.query(`ALTER FUNCTION ${EXPORT_SIG} VOLATILE`);
    expect((await midCall('public.academy_managers', 'Control Export')).seen).toContain('Control Export');
    await db.query(`ALTER FUNCTION ${EXPORT_SIG} STABLE`);
    expect((await state()).digest).toBe(C_STATE_PTF);
    await db.query(`DELETE FROM public.guest_players WHERE full_name LIKE 'Mid Call %' OR full_name LIKE 'Control %'`);
  }, 120_000);

  it('a re-run of apply is a no-op', async () => {
    const r = apply();
    expect(r.status, r.err).toBe(0);
    expect(r.out).toContain('INSERT 0 0');
    expect(await state()).toMatchObject({ ledger_rows: 621, digest: C_STATE_PTF });
  });

  it('export follow-up packet (20261208120000): refuses off-state, applies once, re-runs as a no-op, post-checks, and recovers to the exact PTF state', async () => {
    const FU = join(process.cwd(), 'docs', 'deployment', 'ptf-export-columns');
    const fu = (file: string, vars: Record<string, string> = { expected_sysid: sysid }) =>
      psql('', { single: file !== 'postcheck.sql', path: join(FU, file), vars: file === 'postcheck.sql' ? { shape_academy: A } : vars });
    const constant = (file: string, name: string) =>
      new RegExp(`${name} +CONSTANT text := '([0-9a-f]{64})'`).exec(readFileSync(join(FU, file), 'utf8'))![1];
    const ledgerDigest = async () => (await db.query(`SELECT encode(sha256(convert_to(string_agg(version, E'\\n' ORDER BY version COLLATE "C"), 'UTF8')), 'hex') AS d FROM supabase_migrations.schema_migrations`)).rows[0].d as string;
    expect(await state()).toMatchObject({ ledger_rows: 621, digest: C_STATE_PTF });
    expect(await ledgerDigest()).toBe(C_PTF);
    for (const f of ['apply.sql', 'recovery.sql']) {
      expect(constant(f, 'c_ptf')).toBe(C_PTF);
      expect(constant(f, 'c_state_ptf')).toBe(C_STATE_PTF);
    }
    // the embedded descriptors and the in-flight probe are byte-identical to the reviewed PTF packet's
    for (const f of ['apply.sql', 'recovery.sql', 'postcheck.sql']) {
      const text = readFileSync(join(FU, f), 'utf8');
      for (const d of text.split('-- STATE DESCRIPTOR BEGIN').slice(1)) {
        expect(('-- STATE DESCRIPTOR BEGIN' + d.slice(0, d.indexOf('-- STATE DESCRIPTOR END'))).trim()).toBe(DESCRIPTOR_SQL.trim());
      }
    }

    // refusals change nothing: another cluster; a drifted export ACL
    const wrong = fu('apply.sql', { expected_sysid: '1' });
    expect(wrong.status).toBe(3);
    expect(wrong.err).toMatch(/ptfx apply guard: system identifier/);
    await db.query(`GRANT EXECUTE ON FUNCTION ${EXPORT_SIG} TO anon`);
    const drifted = fu('apply.sql');
    expect(drifted.status).toBe(3);
    expect(drifted.err).toMatch(/ptfx apply guard: the ledger\/object state is neither/);
    await db.query(`REVOKE EXECUTE ON FUNCTION ${EXPORT_SIG} FROM anon`);
    expect(await state()).toMatchObject({ ledger_rows: 621, digest: C_STATE_PTF });

    // first apply
    const first = fu('apply.sql');
    const fuState = (await state()).digest;
    const fuLedger = await ledgerDigest();
    expect(first.status, first.err).toBe(0);
    expect(first.out).toContain('INSERT 0 1');
    expect(first.err).toContain(`ptfx apply: object state ${fuState}, ledger 622 to 20261208120000`);
    expect(constant('apply.sql', 'c_fu')).toBe(fuLedger);
    expect(constant('apply.sql', 'c_state_fu')).toBe(fuState);
    expect(await state()).toMatchObject({ ledger_rows: 622 });
    const after = await asUser(MGR_A, `SELECT rows FROM public.get_players_overview_export($1, NULL, '{}'::jsonb, 'name', 'asc')`, [A]);
    const rows = after[0].rows as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(['birth_date', 'currently_training', 'email', 'full_name', 'last_training_date',
        'location_names', 'next_training_date', 'past_bookings_count', 'person_id', 'phone']);
    }
    const [cfg] = await asUser(MGR_A, `SELECT array_to_string(proconfig, ';') AS c FROM pg_proc WHERE oid = '${EXPORT_SIG}'::regprocedure`);
    expect(cfg.c).toBe('search_path=pg_catalog, pg_temp;plan_cache_mode=force_custom_plan');

    // post-check
    const pc = fu('postcheck.sql');
    expect(pc.status, pc.err).toBe(0);
    expect(pc.rec).toMatchObject({ ledger_rows: '622', ledger_head: '20261208120000', ledger_ok: 't', state_ok: 't',
      state_sha256: fuState, export_acl: 'authenticated=X/postgres,postgres=X/postgres',
      anon_can_execute: 'f', service_role_can_execute: 'f' });
    // the shape record: counts only, consistent with the export itself
    const [{ total: shapeExpected }] = await asUser(MGR_A, `SELECT total FROM public.get_players_overview_export($1, NULL, '{}'::jsonb, 'name', 'asc')`, [A]);
    expect(pc.rec).toMatchObject({ shape_manager_found: 't', shape_total: String(shapeExpected), shape_rows: String(shapeExpected),
      rows_with_exact_keys: String(shapeExpected), distinct_persons: String(shapeExpected), malformed_dates: '0',
      zero_count_with_last: '0', count_without_last: '0' });
    expect(pc.out.match(/-\[ RECORD 1 \]/g)).toHaveLength(3); // object state, manager found, shape
    expect(Number(pc.rec.currently_training)).toBeGreaterThan(0);
    expect(pc.out).not.toMatch(/@x\.nl|@example/); // no contact data in the output

    // re-run: no ledger row, same state
    const again = fu('apply.sql');
    expect(again.status, again.err).toBe(0);
    expect(again.out).toContain('INSERT 0 0');
    expect((await state()).digest).toBe(fuState);

    // recovery: the exact PTF state; a re-run is a no-op
    const rec = fu('recovery.sql');
    expect(rec.status, rec.err).toBe(0);
    expect(rec.out).toContain('DELETE 1');
    expect(rec.err).toContain(`ptfx recovery: object state ${C_STATE_PTF} (the PTF state), ledger 621 to 20261208100000`);
    expect(await state()).toMatchObject({ ledger_rows: 621, digest: C_STATE_PTF });
    expect(await ledgerDigest()).toBe(C_PTF);
    const rec2 = fu('recovery.sql');
    expect(rec2.status, rec2.err).toBe(0);
    expect(rec2.out).toContain('DELETE 0');
    const restored = await asUser(MGR_A, `SELECT rows FROM public.get_players_overview_export($1, NULL, '{}'::jsonb, 'name', 'asc')`, [A]);
    for (const r of restored[0].rows as Array<Record<string, unknown>>) {
      expect(Object.keys(r).sort()).toEqual(['email', 'full_name', 'person_id', 'phone']);
    }
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

    const median5 = async (fn: () => Promise<unknown>) => {
      const ms: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t = performance.now();
        await fn();
        ms.push(performance.now() - t);
      }
      return ms.sort((x, y) => x - y)[2];
    };
    const unfiltered50 = await median5(() => overview(MGR_P, P, {}, 50));
    const training50 = await median5(() => overview(MGR_P, P, { current_training: true }, 50));
    const club50 = await median5(() => overview(MGR_P, P, { training_location_id: LOC }, 50));
    const export2000 = await median5(() => exportCall(MGR_P, P));
    const exported = await exportCall(MGR_P, P);
    const perf = `PTF perf (median of 5, ms): unfiltered/50=${unfiltered50.toFixed(0)} training/50=${training50.toFixed(0)} `
      + `club/50=${club50.toFixed(0)} export/${exported.total}=${export2000.toFixed(0)} bookings=${bookings}`;
    console.log(perf);
    if (process.env.PTF_PERF_OUT) writeFileSync(process.env.PTF_PERF_OUT, `${perf}\n`);
    expect(exported.total).toBe(2000);
    // Budget: a filtered page costs at most 50% + 100 ms over the unfiltered page; the whole-academy
    // export of this fixture stays under 2 s.
    expect(training50).toBeLessThanOrEqual(unfiltered50 * 1.5 + 100);
    expect(club50).toBeLessThanOrEqual(unfiltered50 * 1.5 + 100);
    expect(export2000).toBeLessThanOrEqual(2000);
  }, 180_000);

  it.runIf(process.env.PTF_MEASURE === '1')('§3: the representative 20,000-person measurement (heavy; PTF_MEASURE=1)', async () => {
    // PTF_MEASURE_FOLLOWUP=1 measures the export follow-up (20261208120000) on the same fixture instead,
    // then puts the reviewed PTF export body back, so the recovery test below still sees the PTF state.
    const followUp = process.env.PTF_MEASURE_FOLLOWUP === '1';
    const ptfExportDef = followUp
      ? (await db.query(`SELECT pg_get_functiondef('${EXPORT_SIG}'::regprocedure) AS d`)).rows[0].d as string
      : '';
    if (followUp) {
      await db.query(readFileSync(join(process.cwd(), 'supabase', 'migrations',
        '20261208120000_players_overview_export_training_columns.sql'), 'utf8'));
    }
    try {
      await measureAt20k();
    } finally {
      if (followUp) await db.query(ptfExportDef);
    }
  }, 1_800_000);

  it('forward recovery returns the exact BASE state; a re-run is a no-op; apply then refuses', async () => {
    // P2-1 on the recovery side: a drifted PTF object refuses recovery too
    await db.query(`GRANT EXECUTE ON FUNCTION ${AUTHORITY_SIG} TO authenticated`);
    const drifted = recovery();
    expect(drifted.status).not.toBe(0);
    expect(drifted.err).toMatch(/ptf recovery guard: the object state is not the one this ledger expects/);
    await db.query(`REVOKE EXECUTE ON FUNCTION ${AUTHORITY_SIG} FROM authenticated`);
    expect((await state()).digest).toBe(C_STATE_PTF);

    // P2-4: a STRICT authority passes every grant and refusal check yet silently empties the list (a NULL
    // search reaches it on every normal call) — the state catches it: post-check fails, recovery refuses.
    expect((await overview(MGR_A, A, {})).length).toBeGreaterThan(0);
    await db.query(`ALTER FUNCTION ${AUTHORITY_SIG} STRICT`);
    try {
      expect(await overview(MGR_A, A, {})).toEqual([]);  // why it matters
      const post = psql('postcheck.sql');
      expect(post.status, post.err).toBe(0);
      expect(post.rec).toMatchObject({
        state_ok: 'f', client_roles_ok: 't',
        foreign_access: 'refused: not authorized', foreign_export: 'refused: not authorized', // both probes
      });
      const strictRecovery = recovery();
      expect(strictRecovery.status).not.toBe(0);
      expect(strictRecovery.err).toMatch(/ptf recovery guard: the object state is not the one this ledger expects/);
    } finally {
      await db.query(`ALTER FUNCTION ${AUTHORITY_SIG} CALLED ON NULL INPUT`);
    }
    expect((await state()).digest).toBe(C_STATE_PTF);

    const r = recovery();
    expect(r.status, r.err).toBe(0);
    expect(r.out).toContain('INSERT 0 1');
    expect(r.err).toContain(`ptf recovery: object state ${C_STATE_BASE}`);
    const s = await state();
    expect(s.descriptor).toBe(BASE_STATE);
    expect(s).toMatchObject({ ledger_rows: 622, digest: C_STATE_BASE });
    const ledger = (await db.query(`SELECT encode(sha256(convert_to(string_agg(version, E'\\n' ORDER BY version COLLATE "C"), 'UTF8')), 'hex') AS d FROM supabase_migrations.schema_migrations`)).rows[0].d;
    expect(ledger).toBe(C_RESTORED);
    expect((await db.query(`SELECT to_regnamespace('players_private') AS n`)).rows[0].n).toBeNull();
    // the canonical body is back: the training key is ignored again, and the trainer-union universe returns
    const restored = names(await overview(MGR_A, A, { current_training: true }));
    for (const n of canonicalAList) expect(restored).toContain(n);

    const again = recovery();
    expect(again.status, again.err).toBe(0);
    expect(again.out).toContain('INSERT 0 0');

    const reapply = apply();
    expect(reapply.status).not.toBe(0);
    expect(reapply.err).toMatch(/ptf apply guard: the ledger is neither/);
    expect(await state()).toMatchObject({ ledger_rows: 622, digest: C_STATE_BASE });
  }, 60_000);

  it('the packet constants are the ones this suite derives, and the shared blocks are identical', () => {
    // the canonical descriptor carries every behaviour-affecting pg_proc attribute (P2-4)
    for (const attr of ['pg_get_function_arguments(p.oid)', 'p.prokind', 'p.proisstrict', 'p.proretset', 'p.prosecdef',
      'p.proleakproof', 'p.proparallel', 'p.prosupport', 'p.provolatile', 'p.proconfig', 'p.proacl', 'p.prosrc', 'l.lanname',
      'p.proowner', 'pg_get_function_result(p.oid)']) {
      expect(DESCRIPTOR_SQL, attr).toContain(attr);
    }
    let copies = 0;
    for (const f of ['apply.sql', 'recovery.sql', 'postcheck.sql']) {
      const text = readFileSync(join(PACKET, f), 'utf8');
      expect(text).toContain(C_PTF);
      expect(text).toContain(C_STATE_PTF);
      const desc = blocks(f, 'STATE DESCRIPTOR');
      expect(desc.length, f).toBe(2);
      for (const d of desc) expect(d, f).toBe(DESCRIPTOR_SQL); // byte-for-byte, indentation included
      copies += desc.length;
      const probe = blocks(f, 'IN-FLIGHT PROBE');
      expect(probe.length, f).toBeGreaterThanOrEqual(1);
      for (const p of probe) expect(p.trim(), f).toBe(blocks('apply.sql', 'IN-FLIGHT PROBE')[0].trim());
    }
    expect(copies).toBe(6);
    expect(readFileSync(join(PACKET, 'apply.sql'), 'utf8')).toContain(C_BASE);
    expect(readFileSync(join(PACKET, 'a1_preserve_repair.sql'), 'utf8')).toContain(C_BASE); // its pre-apply-only ledger
    expect(readFileSync(join(PACKET, 'apply.sql'), 'utf8')).toContain(C_STATE_BASE);
    expect(readFileSync(join(PACKET, 'recovery.sql'), 'utf8')).toContain(C_RESTORED);
    expect(readFileSync(join(PACKET, 'recovery.sql'), 'utf8')).toContain(C_STATE_BASE);
    const readme = readFileSync(join(PACKET, 'README.md'), 'utf8');
    for (const line of [...BASE_STATE.split('\n'), ...PTF_STATE.split('\n')]) expect(readme).toContain(line);
  });
});

/**
 * Decision packet §3: one academy (Q) with 20,000 people (16,000 guests + 4,000 registered); 5,000 sessions
 * (a third in ongoing cycles, a third in cycles not yet started, a third standalone, half past / half
 * ahead); ~200,000 bookings over all statuses; two other academies (R, S) share Q's ten trainers with
 * ~100,000 bookings of history. Medians of 5; the top-level plan and buffers, and the authority's own plan
 * (auto_explain, nested) of the export. Writes a JSON report to PTF_MEASURE_OUT when set.
 */
async function measureAt20k(): Promise<void> {
  const Q = 'e1000000-0000-0000-0000-00000000000e', R = 'e2000000-0000-0000-0000-00000000000e', S = 'e3000000-0000-0000-0000-00000000000e';
  const MGR_Q = 'e1000000-0000-0000-0000-0000000000e1';
  const t0 = performance.now();
  await db.query(`
    INSERT INTO public.academy_profiles (id) VALUES ('${Q}'), ('${R}'), ('${S}');
    INSERT INTO public.academy_managers VALUES ('${Q}', '${MGR_Q}');
    INSERT INTO public.trainer_profiles SELECT md5('tq' || i)::uuid, gen_random_uuid() FROM generate_series(1, 10) i;
    INSERT INTO public.academy_trainers SELECT a, md5('tq' || i)::uuid, 'active'
      FROM (VALUES ('${Q}'::uuid), ('${R}'::uuid), ('${S}'::uuid)) v(a), generate_series(1, 10) i;
    INSERT INTO public.locations (id, name) SELECT md5('lq' || i)::uuid, 'Q Club ' || i FROM generate_series(1, 5) i;
    INSERT INTO public.academy_locations SELECT '${Q}', md5('lq' || i)::uuid, true FROM generate_series(1, 5) i;
    INSERT INTO public.guest_players (id, academy_profile_id, trainer_id, full_name, email, phone)
      SELECT md5('qg' || i)::uuid, '${Q}', md5('tq' || (1 + i % 10))::uuid, 'Q Guest ' || i, 'qg' || i || '@x.nl',
             '06' || lpad(i::text, 8, '0') FROM generate_series(1, 16000) i;
    INSERT INTO public.profiles (id, full_name, email) SELECT md5('qp' || i)::uuid, 'Q Profile ' || i, 'qp' || i || '@x.nl'
      FROM generate_series(1, 4000) i;
    INSERT INTO public.availability_slots (id, trainer_id, academy_profile_id, location_id, cyclus_id, start_time, end_time)
      SELECT md5('qs-on' || c || '-' || s)::uuid, md5('tq' || (1 + c % 10))::uuid, '${Q}'::uuid, md5('lq' || (1 + c % 5))::uuid,
             md5('qc-on' || c)::uuid, now() + (s - 7) * interval '7 days', now() + (s - 7) * interval '7 days' + interval '1 hour'
        FROM generate_series(1, 139) c, generate_series(1, 12) s
      UNION ALL
      SELECT md5('qs-fu' || c || '-' || s)::uuid, md5('tq' || (1 + c % 10))::uuid, '${Q}'::uuid, md5('lq' || (1 + c % 5))::uuid,
             md5('qc-fu' || c)::uuid, now() + s * interval '7 days', now() + s * interval '7 days' + interval '1 hour'
        FROM generate_series(1, 139) c, generate_series(1, 12) s
      UNION ALL
      SELECT md5('qs-sa' || i)::uuid, md5('tq' || (1 + i % 10))::uuid, '${Q}'::uuid, md5('lq' || (1 + i % 5))::uuid, NULL::uuid,
             now() + (i - 832) * interval '6 hours', now() + (i - 832) * interval '6 hours' + interval '1 hour'
        FROM generate_series(1, 1664) i;
    CREATE TEMP TABLE qs AS SELECT id, (row_number() OVER (ORDER BY id) - 1)::int AS n
      FROM public.availability_slots WHERE academy_profile_id = '${Q}';
    CREATE TEMP TABLE qppl AS
      SELECT md5('qg' || i)::uuid AS gid, NULL::uuid AS pid, i AS n FROM generate_series(1, 16000) i
      UNION ALL SELECT NULL::uuid, md5('qp' || i)::uuid, 16000 + i FROM generate_series(1, 4000) i;
    INSERT INTO public.bookings (slot_id, guest_player_id, player_id, status)
      SELECT qs.id, p.gid, p.pid,
             CASE WHEN k = 1 THEN 'confirmed' ELSE (ARRAY['confirmed','completed','cancelled','pending'])[1 + ((p.n * 31 + k * 17) % 4)] END
        FROM qppl p CROSS JOIN generate_series(1, 10) k JOIN qs ON qs.n = (p.n * 7 + k * 503) % 5000;
    INSERT INTO public.availability_slots (id, trainer_id, academy_profile_id, location_id, start_time, end_time)
      SELECT md5('rs' || a || '-' || i)::uuid, md5('tq' || (1 + i % 10))::uuid, a, NULL, now() - i * interval '1 day',
             now() - i * interval '1 day' + interval '1 hour'
        FROM (VALUES ('${R}'::uuid), ('${S}'::uuid)) v(a), generate_series(1, 1000) i;
    INSERT INTO public.guest_players (id, academy_profile_id, trainer_id, full_name, email)
      SELECT md5('rsg' || a || '-' || i)::uuid, a, md5('tq' || (1 + i % 10))::uuid, 'RS Guest ' || i, 'rs' || i || '@x.nl'
        FROM (VALUES ('${R}'::uuid), ('${S}'::uuid)) v(a), generate_series(1, 5000) i;
    INSERT INTO public.bookings (slot_id, guest_player_id, status)
      SELECT md5('rs' || a || '-' || (1 + (i * 13 + k * 101) % 1000))::uuid, md5('rsg' || a || '-' || i)::uuid,
             (ARRAY['confirmed','completed','cancelled'])[1 + ((i + k) % 3)]
        FROM (VALUES ('${R}'::uuid), ('${S}'::uuid)) v(a), generate_series(1, 5000) i, generate_series(1, 8) k
      UNION ALL
      SELECT md5('rs' || '${R}' || '-' || (1 + i % 1000))::uuid, md5('qg' || i)::uuid, 'completed' FROM generate_series(1, 20000) i;
    -- MERGED MULTI-ACADEMY PEOPLE (P1-1): 5,000 Q people get a second Q guest side ("Q Twin"), linked to
    -- the same person as an OLDER R guest (4,000, "R Secret") or an R-only account holder (1,000,
    -- "R Account", booked only on R's sessions). Their global persons.full_name is R's — exactly what
    -- rederive_person derives — so a leak would put R names in Q's list, search and export.
    INSERT INTO public.guest_players (id, academy_profile_id, full_name, email, created_at)
      SELECT md5('qtwin' || i)::uuid, '${Q}'::uuid, 'Q Twin ' || i, 'qtwin' || i || '@x.nl', now() - interval '1 day'
        FROM generate_series(1, 5000) i
      UNION ALL
      SELECT md5('rsecret' || i)::uuid, '${R}'::uuid, 'R Secret ' || i, 'rsecret' || i || '@x.nl', now() - interval '60 days'
        FROM generate_series(1, 4000) i;
    INSERT INTO public.profiles (id, full_name, email)
      SELECT md5('racct' || i)::uuid, 'R Account ' || i, 'racct' || i || '@x.nl' FROM generate_series(1, 1000) i;
    INSERT INTO public.bookings (slot_id, player_id, status)
      SELECT md5('rs' || '${R}' || '-' || (1 + i % 1000))::uuid, md5('racct' || i)::uuid, 'confirmed' FROM generate_series(1, 1000) i;
    INSERT INTO public.person_links (person_id, guest_player_id)
      SELECT md5('qg' || i)::uuid, md5('qg' || i)::uuid FROM generate_series(1, 5000) i
      UNION ALL SELECT md5('qg' || i)::uuid, md5('qtwin' || i)::uuid FROM generate_series(1, 5000) i
      UNION ALL SELECT md5('qg' || i)::uuid, md5('rsecret' || i)::uuid FROM generate_series(1, 4000) i;
    INSERT INTO public.person_links (person_id, profile_id)
      SELECT md5('qg' || (4000 + i))::uuid, md5('racct' || i)::uuid FROM generate_series(1, 1000) i;
    INSERT INTO public.persons (id, full_name, user_id)
      SELECT md5('qg' || i)::uuid, 'R Secret ' || i, NULL::uuid FROM generate_series(1, 4000) i
      UNION ALL SELECT md5('qg' || (4000 + i))::uuid, 'R Account ' || i, gen_random_uuid() FROM generate_series(1, 1000) i;
    ANALYZE;`);
  const setupMs = performance.now() - t0;
  const counts = (await db.query(`SELECT
      (SELECT count(*) FROM public.availability_slots WHERE academy_profile_id = '${Q}')::int AS q_sessions,
      (SELECT count(*) FROM public.bookings b JOIN public.availability_slots s ON s.id = b.slot_id WHERE s.academy_profile_id = '${Q}')::int AS q_bookings,
      (SELECT count(*) FROM public.bookings b JOIN public.availability_slots s ON s.id = b.slot_id WHERE s.academy_profile_id IN ('${R}', '${S}'))::int AS rs_bookings`)).rows[0];

  const median5 = async (fn: () => Promise<unknown>) => {
    const ms: number[] = [];
    for (let i = 0; i < 5; i++) { const t = performance.now(); await fn(); ms.push(performance.now() - t); }
    return { median: ms.sort((x, y) => x - y)[2], runs: ms };
  };
  const clubQ = (await db.query(`SELECT md5('lq1')::uuid AS id`)).rows[0].id as string;
  const unfiltered = await median5(() => overview(MGR_Q, Q, {}, 50));
  const training = await median5(() => overview(MGR_Q, Q, { current_training: true }, 50));
  const club = await median5(() => overview(MGR_Q, Q, { training_location_id: clubQ }, 50));
  const exp = await median5(() => exportCall(MGR_Q, Q));
  const [{ total, payload_bytes, r_names, merged_named_q }] = await asUser(MGR_Q,
    `SELECT e.total, octet_length(e.rows::text) AS payload_bytes,
            (SELECT count(*) FROM jsonb_array_elements(e.rows) x WHERE x->>'full_name' LIKE 'R %')::int AS r_names,
            (SELECT count(*) FROM jsonb_array_elements(e.rows) x
              WHERE x->>'person_id' IN (SELECT md5('qg' || i)::uuid::text FROM generate_series(1, 5000) i)
                AND x->>'full_name' LIKE 'Q Twin %')::int AS merged_named_q
       FROM public.get_players_overview_export($1, NULL, '{}'::jsonb, 'name', 'asc') e`, [Q]);
  // the leak surfaces the P1-1 fix closes, at scale: no R name in search either
  const [{ secret_hits }] = await asUser(MGR_Q,
    `SELECT count(*)::int AS secret_hits FROM public.get_players_overview('academy', $1, 'Secret', '{}'::jsonb, 'name', 'asc', 50, 0)`, [Q]);
  const plan = async (sql: string, params: unknown[]) =>
    (await asUser(MGR_Q, `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`, params)).map((r) => r['QUERY PLAN']).join('\n');
  const topPlans = {
    list_unfiltered: await plan(`SELECT * FROM public.get_players_overview('academy', $1, NULL, '{}'::jsonb, 'name', 'asc', 50, 0)`, [Q]),
    list_training: await plan(`SELECT * FROM public.get_players_overview('academy', $1, NULL, '{"current_training": true}'::jsonb, 'name', 'asc', 50, 0)`, [Q]),
    export: await plan(`SELECT total FROM public.get_players_overview_export($1, NULL, '{}'::jsonb, 'name', 'asc')`, [Q]),
  };
  // the authority's own plan inside the export, via auto_explain (nested statements), sent as NOTICEs
  const notices: string[] = [];
  const onNotice = (n: { message?: string }) => { if (n.message) notices.push(n.message); };
  const autoExplain = await db.query(`LOAD 'auto_explain'`).then(() => true, (e: Error) => { notices.push(`auto_explain unavailable: ${e.message}`); return false; });
  db.on('notice', onNotice);
  try {
    await db.query('BEGIN');
    if (autoExplain) await db.query(`SET LOCAL auto_explain.log_min_duration = 0; SET LOCAL auto_explain.log_analyze = on;
      SET LOCAL auto_explain.log_buffers = on; SET LOCAL auto_explain.log_nested_statements = on;
      SET LOCAL auto_explain.log_level = notice; SET LOCAL client_min_messages = notice;`);
    await db.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [MGR_Q]);
    await db.query(`SELECT total FROM public.get_players_overview_export($1, NULL, '{}'::jsonb, 'name', 'asc')`, [Q]);
  } finally {
    await db.query('ROLLBACK');
    db.off('notice', onNotice);
  }
  const server = (await db.query('SHOW server_version')).rows[0].server_version as string;
  const timeoutMs = 8000; // Supabase platform default for authenticated — UNVERIFIED until Tom's A1 observation
  const report = {
    server, setup_ms: Math.round(setupMs), ...counts, persons_exported: Number(total), payload_bytes: Number(payload_bytes),
    merged_multi_academy_people: 5000, merged_named_from_oldest_q_side: Number(merged_named_q),
    r_names_in_export: Number(r_names), search_secret_hits: Number(secret_hits),
    list_unfiltered_ms: unfiltered, list_training_ms: training, list_club_ms: club, export_ms: exp,
    budgets: {
      list_training_ok: training.median <= unfiltered.median * 1.5 + 100,
      list_club_ok: club.median <= unfiltered.median * 1.5 + 100,
      export_ok_vs_unverified_8s_timeout: exp.median <= timeoutMs * 0.5,
    },
    top_level_plans: topPlans,
    authority_plan_notices: notices,
  };
  if (process.env.PTF_MEASURE_OUT) writeFileSync(process.env.PTF_MEASURE_OUT, JSON.stringify(report, null, 2));
  console.log(`PTF §3 (${server}): unfiltered=${unfiltered.median.toFixed(0)}ms training=${training.median.toFixed(0)}ms `
    + `club=${club.median.toFixed(0)}ms export(${total})=${exp.median.toFixed(0)}ms payload=${payload_bytes}B`);
  expect(Number(total)).toBe(20000);
  // P1-1 at scale: merged people keep their own Q name (the oldest admitted Q guest is the "Q Twin", a day
  // older than the Q guest), and no R-derived name reaches Q's export or search
  expect(report).toMatchObject({ r_names_in_export: 0, search_secret_hits: 0, merged_named_from_oldest_q_side: 5000 });
  expect(report.budgets).toEqual({ list_training_ok: true, list_club_ok: true, export_ok_vs_unverified_8s_timeout: true });
}
