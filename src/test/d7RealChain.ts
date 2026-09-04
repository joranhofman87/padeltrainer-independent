// @vitest-environment node
//
// D7 RUNTIME — the shared real-chain harness.
//
// It boots a disposable embedded PostgreSQL, supplies ONLY the platform infrastructure the hosted
// project provides and this repository does not own, and replays the shipped migration lineage in
// TRUE FILENAME ORDER, one transaction per file. Not one product relation, column, policy, index,
// constraint or trigger is written here: every product fact the D7 evidence measures comes out of
// the replayed lineage.
//
// WHY IT REPLAYS IN TRUE FILENAME ORDER, AND WHY THAT MATTERS SO MUCH HERE. The D7 runtime cutover
// ships two migrations on OPPOSITE sides of ABC-27, and each side is load-bearing:
//
//   `20261118115000_d7_runtime_crons.sql`            BEFORE — so `supabase db push` cannot apply
//     ABC-27 while the legacy `notify-rebook-member-open` job is still armed and about to lose
//     EXECUTE on the very RPC it calls. The order is enforced by the filename, not by a runbook.
//   `20261203110000_d7_retire_member_open_surfaces.sql` AFTER — it reads a column only ABC-27
//     creates, and it drops four functions ABC-27 itself re-creates.
//   `20261203120000_d7_paid_group_hold_safety.sql`      AFTER — it REPLACES an ABC-27-owned
//     function body, which cannot exist until ABC-27 has installed it.
//
// "After", never "last": later migrations may join the lineage behind any of these and nothing here
// may depend on tail position.
//
// The frozen ABC-27 suite builds its predecessor from the directory MINUS the file under test,
// which sweeps the POST file in and replays it BEFORE ABC-27 — an order production never sees. That
// file carries a prerequisite guard so the inversion is a clean no-op, and a guard that no-ops is a
// FAIL-OPEN: nothing in the frozen suite can tell "correctly skipped an impossible order" from
// "skips always and does nothing at all". This harness is the other half of that pair. It runs both
// files where they really run, so the evidence built on it is evidence about the schema production
// will actually have.
//
// `holdBackFrom` exists for exactly one reason: to let a test apply the TAIL of the lineage itself,
// onto a clone, so several independent evidence databases can share one expensive replay. It names
// the file the tail STARTS at and the harness derives the rest, so applying the held-back set after
// the template is filename order by construction.
//
// IT NAMES A START, NOT A LIST, AND THAT IS THE POINT. An explicit list had to be the last n
// entries of the directory, which made every evidence file depend on which migration happened to be
// last — a tail-position proxy that a single new migration invalidates. Deriving the suffix means a
// migration joining behind these is swept into the same held-back tail automatically and still
// applied in filename order.
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const { Client } = pg;

export const MIGRATIONS_DIR = resolve(process.cwd(), 'supabase', 'migrations');
export const ABC27 = '20261118120000_abc27_rebook_round_notification_authority.sql';
/**
 * The cron retirement sorts BEFORE ABC-27 by version, so `supabase db push` cannot apply ABC-27
 * while the legacy job is still armed. It is therefore MID-LINEAGE here and can never be held back.
 */
export const D7_CRONS = '20261118115000_d7_runtime_crons.sql';
/** The schema half sorts AFTER ABC-27: it reads a column only ABC-27 creates. */
export const D7_RETIRE = '20261203110000_d7_retire_member_open_surfaces.sql';
/**
 * The paid-group court-hold closure. Also post-ABC-27, and for a stronger reason: it REPLACES an
 * ABC-27-owned function body, which only exists once ABC-27 has installed it.
 */
export const D7_PAID_GROUP = '20261203120000_d7_paid_group_hold_safety.sql';
/**
 * The dispatch linearization closure. Post-ABC-27 for the same reason as the paid-group file: it
 * REPLACES an ABC-27-owned body — `rebook_member_open_begin_dispatch` — so the authority it edits
 * has to exist first.
 */
export const D7_LINEARIZE = '20261203130000_d7_dispatch_linearization.sql';
/**
 * The booking-anchored paid-group hold. Supersedes `D7_PAID_GROUP`'s claim-derived predicate: a
 * claim is deleted by an ordinary guest merge while the payment and the booking survive, so the
 * hold is read from `bookings.payment_status` + `paid_by_*` where the product itself keeps it.
 */
export const D7_BOOKING_HOLD = '20261203140000_d7_paid_group_hold_booking_anchored.sql';
/** The `after_cutoff` reason split, and the cron/index guard hardening. */
export const D7_CUTOFF_REASON = '20261203150000_d7_dispatch_after_cutoff_reason.sql';
export const D7_GUARD_HARDENING = '20261203160000_d7_runtime_guard_hardening.sql';
/**
 * THE SELECTION AUTHORITY, in four files. One clusterer and its Domain-P candidate bridges; the
 * one actor surface in front of them; the legacy naming chain, re-issued into both normalized
 * cores; and the apply mirror the client rule requires. The browser names a source cycle or a
 * cohort intent, and the database decides everything else.
 */
export const D7_SELECTION = '20261203180000_d7_cohort_selection_authority.sql';
export const D7_SELECTION_SURFACE = '20261203190000_d7_selection_actor_surface.sql';
export const D7_HUMAN_NAMES = '20261203200000_d7_human_child_names.sql';
export const D7_SELECTION_APPLY = '20261203210000_d7_selection_apply_surface.sql';

/** Every shipped migration, in filename order. Lexical order IS chronological order here. */
export const lineage = (): string[] =>
  readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

export const migrationSql = (file: string): string =>
  readFileSync(join(MIGRATIONS_DIR, file), 'utf8');

// ── PLATFORM INFRASTRUCTURE: everything the repository does not own, and nothing else ─────────
//
// The three runtime roles and Supabase's default-privilege seeds, the `extensions` schema, `auth`
// (users plus the REAL `auth.uid()` that reads PostgREST's per-request JWT GUC — a convenience stub
// would make every identity NULL and every authorization test pass while proving nothing),
// `storage`, `vault`, and the realtime publication. `pgcrypto` is deliberately NOT created here:
// the shipped repair migration owns it and must run at its real chain position.
export const PLATFORM_SHIM_SQL = /* sql */ `
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

  CREATE SCHEMA IF NOT EXISTS extensions;
  GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;

  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE TABLE IF NOT EXISTS auth.users (
    id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb,
    last_sign_in_at timestamptz, email_confirmed_at timestamptz, created_at timestamptz DEFAULT now());
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
    SELECT coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    )::uuid
  $fn$;
  CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $fn$
    SELECT coalesce(nullif(current_setting('request.jwt.claims', true)::json->>'role',''), current_user::text)
  $fn$;
  CREATE OR REPLACE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS $fn$
    SELECT nullif(current_setting('request.jwt.claims', true)::json->>'email','')
  $fn$;
  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
  GRANT SELECT ON auth.users TO service_role;

  CREATE SCHEMA IF NOT EXISTS storage;
  CREATE TABLE IF NOT EXISTS storage.buckets (
    id text PRIMARY KEY, name text NOT NULL, owner uuid, owner_id text,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
    public boolean DEFAULT false, avif_autodetection boolean DEFAULT false,
    file_size_limit bigint, allowed_mime_types text[]);
  CREATE TABLE IF NOT EXISTS storage.objects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text REFERENCES storage.buckets(id),
    name text, owner uuid, owner_id text,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
    last_accessed_at timestamptz DEFAULT now(), metadata jsonb, user_metadata jsonb,
    path_tokens text[] GENERATED ALWAYS AS (string_to_array(name, '/')) STORED,
    version text, level integer);
  ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
  CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[]
    LANGUAGE sql IMMUTABLE AS $fn$ SELECT string_to_array(name, '/') $fn$;
  GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;

  CREATE SCHEMA IF NOT EXISTS vault;
  CREATE TABLE IF NOT EXISTS vault.secrets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text UNIQUE, secret text,
    description text, created_at timestamptz DEFAULT now());
  CREATE OR REPLACE VIEW vault.decrypted_secrets AS
    SELECT id, name, secret AS decrypted_secret, description, created_at FROM vault.secrets;
  CREATE OR REPLACE FUNCTION vault.create_secret(new_secret text, new_name text DEFAULT NULL, new_description text DEFAULT '')
  RETURNS uuid LANGUAGE plpgsql AS $fn$
  DECLARE v_id uuid; BEGIN
    INSERT INTO vault.secrets(name, secret, description) VALUES (new_name, new_secret, new_description)
    ON CONFLICT (name) DO UPDATE SET secret = EXCLUDED.secret RETURNING id INTO v_id; RETURN v_id;
  END $fn$;
  CREATE OR REPLACE FUNCTION vault.update_secret(id uuid, new_secret text DEFAULT NULL, new_name text DEFAULT NULL, new_description text DEFAULT NULL)
  RETURNS void LANGUAGE plpgsql AS $fn$ BEGIN
    UPDATE vault.secrets s SET secret = COALESCE(new_secret, s.secret),
      name = COALESCE(new_name, s.name), description = COALESCE(new_description, s.description)
    WHERE s.id = update_secret.id; END $fn$;

  CREATE PUBLICATION supabase_realtime;
`;

// ── STUB `pg_cron` / `pg_net` PACKAGES ───────────────────────────────────────────────────────
//
// The lineage runs `CREATE EXTENSION IF NOT EXISTS pg_cron` / `pg_net` verbatim and a vanilla
// distribution ships neither. Rather than slice those statements out of the product files — the
// exact fixup this harness exists to avoid — the packages are written to a disposable directory
// and reached through PostgreSQL 18's `extension_control_path`, so the shipped statements execute
// unchanged. The bodies are INERT: nothing here makes an HTTP call, and `cron.job` is an ordinary
// table, which is what lets the cron evidence read `active` directly.
const STUB_EXTENSIONS: ReadonlyArray<readonly [string, string, string]> = [
  ['pg_cron', '1.6', `
    CREATE SCHEMA cron;
    CREATE TABLE cron.job (
      jobid bigserial PRIMARY KEY, schedule text, command text, nodename text DEFAULT 'localhost',
      nodeport int DEFAULT 5432, database text DEFAULT current_database(), username text DEFAULT current_user,
      active boolean DEFAULT true, jobname text UNIQUE);
    CREATE TABLE cron.job_run_details (
      jobid bigint, runid bigserial PRIMARY KEY, job_pid int, database text, username text,
      command text, status text, return_message text, start_time timestamptz, end_time timestamptz);
    CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint
    LANGUAGE plpgsql AS $f$ DECLARE v bigint; BEGIN
      INSERT INTO cron.job(jobname, schedule, command) VALUES (job_name, schedule, command)
      ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command
      RETURNING jobid INTO v; RETURN v; END $f$;
    CREATE FUNCTION cron.schedule(schedule text, command text) RETURNS bigint
    LANGUAGE plpgsql AS $f$ DECLARE v bigint; BEGIN
      INSERT INTO cron.job(jobname, schedule, command) VALUES (command, schedule, command)
      ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule RETURNING jobid INTO v; RETURN v; END $f$;
    CREATE FUNCTION cron.unschedule(job_name text) RETURNS boolean
    LANGUAGE plpgsql AS $f$ BEGIN DELETE FROM cron.job WHERE jobname = job_name; RETURN true; END $f$;
    CREATE FUNCTION cron.unschedule(job_id bigint) RETURNS boolean
    LANGUAGE plpgsql AS $f$ BEGIN DELETE FROM cron.job WHERE jobid = job_id; RETURN true; END $f$;
    CREATE FUNCTION cron.alter_job(job_id bigint, schedule text DEFAULT NULL, command text DEFAULT NULL,
      database text DEFAULT NULL, username text DEFAULT NULL, active boolean DEFAULT NULL) RETURNS void
    LANGUAGE plpgsql AS $f$ BEGIN
      UPDATE cron.job j SET schedule = COALESCE(alter_job.schedule, j.schedule),
        command = COALESCE(alter_job.command, j.command), active = COALESCE(alter_job.active, j.active)
      WHERE j.jobid = alter_job.job_id; END $f$;
  `],
  ['pg_net', '0.14.0', `
    CREATE SCHEMA net;
    CREATE TABLE net._http_response (
      id bigserial PRIMARY KEY, status_code int, content_type text, headers jsonb, content text,
      timed_out boolean, error_msg text, created timestamptz DEFAULT now());
    -- THE OUTBOUND QUEUE IS A REAL TABLE, AND THAT IS THE POINT.
    --
    -- These two used to be \`SELECT 1\`, which made an outbound HTTP call from SQL completely
    -- invisible to every form of evidence: it writes no row, changes no catalog, and executes no
    -- DDL. A migration could have selected from \`notification_outbox\` and posted it anywhere, and
    -- the replay would have recorded nothing at all while production queued and sent the request.
    --
    -- Recording the call into an ordinary table puts it back inside something that CAN be
    -- measured: the statement-level DML witness is armed on every table in every user schema,
    -- \`net\` included, so an outbound call during a migration now shows up as an INSERT the
    -- witness saw. That is also closer to what the real extension does, which queues rather than
    -- calls inline.
    CREATE TABLE net.http_request_queue (
      id bigserial PRIMARY KEY, method text NOT NULL, url text NOT NULL,
      body jsonb, headers jsonb, timeout_milliseconds int, queued timestamptz DEFAULT now());
    CREATE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
      headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds int DEFAULT 5000) RETURNS bigint
    LANGUAGE sql AS $f$
      INSERT INTO net.http_request_queue(method, url, body, headers, timeout_milliseconds)
      VALUES ('POST', url, body, headers, timeout_milliseconds) RETURNING id
    $f$;
    CREATE FUNCTION net.http_get(url text, params jsonb DEFAULT '{}'::jsonb, headers jsonb DEFAULT '{}'::jsonb,
      timeout_milliseconds int DEFAULT 5000) RETURNS bigint
    LANGUAGE sql AS $f$
      INSERT INTO net.http_request_queue(method, url, headers, timeout_milliseconds)
      VALUES ('GET', url, headers, timeout_milliseconds) RETURNING id
    $f$;
  `],
];

export interface D7Chain {
  /** The template database every evidence database clones. Already replayed. */
  templateDb: string;
  /**
   * Build an ADDITIONAL template in the same cluster, from the same lineage, with files omitted.
   *
   * This exists for ONE purpose: counterfactual controls. A migration that sorts mid-lineage
   * cannot be held back, so the only way to show that it is the thing producing an effect is to
   * replay the lineage WITHOUT it and measure the difference. Such a template is deliberately NOT
   * a claim about any real order — the tests that use it say so.
   */
  buildTemplate: (name: string, opts?: { omit?: string[]; vaultServiceRoleKey?: string | null }) => Promise<void>;
  /** Clone any database in this cluster into a fresh one and connect to it. */
  cloneFrom: (template: string, name: string) => Promise<pg.Client>;
  /** A superuser client on `postgres`, for CREATE DATABASE and role work. */
  admin: pg.Client;
  /** Open a client on any database in this cluster. The caller owns `connect()`/`end()`. */
  connect: (database: string) => pg.Client;
  /** Clone the template into a fresh database and return a connected client on it. */
  clone: (name: string) => Promise<pg.Client>;
  /** The files deliberately NOT applied to the template, in filename order. */
  heldBack: string[];
  /** Apply the held-back tail to one database, in filename order, one transaction per file. */
  applyHeldBack: (client: pg.Client) => Promise<void>;
  /** Tear the cluster down and remove every disposable directory. */
  shutdown: () => Promise<void>;
}

export interface BootOptions {
  port: number;
  /** Prefix for every database this harness creates. Must be unique per test file. */
  prefix: string;
  /**
   * Hold back every migration sorting at or after this one, so a test can apply that tail itself.
   * The set is DERIVED from the directory, never enumerated, so it cannot fall behind a new file.
   */
  holdBackFrom?: string;
  /**
   * Files to omit ENTIRELY from the primary template. For counterfactual controls only; see
   * `buildTemplate`. Unlike `holdBackFrom` these are never applied afterwards.
   */
  omit?: string[];
  /**
   * Seed `vault.secrets.service_role_key` BEFORE the replay.
   *
   * It is load-bearing for the cron evidence: `20260722100000_rebook_crons_use_vault.sql` RETURNS
   * EARLY when the secret is missing, so without it the legacy `notify-rebook-member-open` job is
   * never scheduled at all — and "the retirement removed it" would be a vacuous pass over a job
   * that never existed.
   */
  vaultServiceRoleKey?: string | null;
}

const disposableDirs: string[] = [];

function writeStubExtensions(): string {
  // PostgreSQL appends `/extension` to every `extension_control_path` entry, and control files are
  // read from `<entry>/extension/`. Writing them a level up leaves them invisible with no
  // diagnostic beyond "extension is not available", so the subdirectory is explicit here.
  const base = mkdtempSync(join(tmpdir(), 'd7-chain-ext-'));
  disposableDirs.push(base);
  const dir = join(base, 'extension');
  mkdirSync(dir);
  for (const [name, version, body] of STUB_EXTENSIONS) {
    writeFileSync(
      join(dir, `${name}.control`),
      `comment = 'disposable ${name} stub (platform infrastructure model)'\n`
      + `default_version = '${version}'\nrelocatable = false\nsuperuser = true\n`,
    );
    writeFileSync(join(dir, `${name}--${version}.sql`), body);
  }
  return base;
}

export async function bootD7Chain(opts: BootOptions): Promise<D7Chain> {
  const all = lineage();
  // THE SUFFIX IS DERIVED, WHICH IS WHAT MAKES IT ORDER-SAFE: every held-back file sorts at or
  // after the named start, and therefore after every applied file, so applying them afterwards is
  // filename order however many files later join the lineage.
  const heldBack = opts.holdBackFrom ? all.filter((f) => f >= opts.holdBackFrom!) : [];
  if (opts.holdBackFrom && !all.includes(opts.holdBackFrom)) {
    throw new Error(`holdBackFrom names ${opts.holdBackFrom}, which is not in the lineage`);
  }
  const omit = new Set(opts.omit ?? []);
  const applied = all.slice(0, all.length - heldBack.length).filter((f) => !omit.has(f));
  if (applied.length < 600) {
    throw new Error(`lineage is implausibly short (${applied.length} files) — refusing to build evidence on it`);
  }

  const dataDir = mkdtempSync(join(tmpdir(), `${opts.prefix}-pgdata-`));
  disposableDirs.push(dataDir);
  const epg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port: opts.port,
    persistent: false,
  });
  await epg.initialise();
  await epg.start();

  const connect = (database: string): pg.Client =>
    new Client({ host: '127.0.0.1', port: opts.port, user: 'postgres', password: 'postgres', database });

  const admin = connect('postgres');
  await admin.connect();
  await admin.query(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE ROLE runtime_bridge NOLOGIN;
    GRANT runtime_bridge TO anon, authenticated, service_role;
  `);

  // UTF-8 with the BUILTIN `C.UTF8` locale, exactly as the ABC-27 lineage requires. Both order by
  // code point (the determinism the digests need); libc `C` additionally classifies every byte as
  // ASCII, which makes the shipped diacritic-folding migration refuse to install.
  const replayInto = async (
    database: string,
    files: readonly string[],
    vaultKey: string | null | undefined,
  ): Promise<void> => {
    await admin.query(`CREATE DATABASE ${database}
      TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF8'`);
    const tpl = connect(database);
    await tpl.connect();
    try {
      const stubDir = writeStubExtensions();
      await tpl.query(`SET extension_control_path = '$system:${stubDir}'`);
      {
        // Fail fast and legibly: without this the first shipped `CREATE EXTENSION` fails hundreds
        // of files deep with a message that says nothing about the control path.
        const { rows } = await tpl.query(
          `SELECT (SELECT count(*)::int FROM pg_available_extensions
                    WHERE name IN ('pg_cron','pg_net')) AS stubs`,
        );
        if (rows[0].stubs !== 2) throw new Error(`stub extension packages are not visible (dir=${stubDir})`);
      }
      await tpl.query(PLATFORM_SHIM_SQL);
      if (vaultKey) {
        await tpl.query(`INSERT INTO vault.secrets(name, secret) VALUES ('service_role_key', $1)`, [vaultKey]);
      }
      for (const file of files) {
        try {
          await tpl.query('BEGIN');
          await tpl.query(migrationSql(file));
          await tpl.query('COMMIT');
        } catch (err) {
          await tpl.query('ROLLBACK').catch(() => undefined);
          throw new Error(`lineage failed at ${file}: ${(err as Error).message}`);
        }
      }
    } finally {
      await tpl.end();
    }
  };

  const templateDb = `${opts.prefix}_template`;
  await replayInto(templateDb, applied, opts.vaultServiceRoleKey);

  const applyHeldBack = async (client: pg.Client): Promise<void> => {
    for (const file of heldBack) {
      try {
        await client.query('BEGIN');
        await client.query(migrationSql(file));
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`held-back migration failed at ${file}: ${(err as Error).message}`);
      }
    }
  };

  const clones: pg.Client[] = [];
  const cloneFrom = async (template: string, name: string): Promise<pg.Client> => {
    await admin.query(`CREATE DATABASE ${name} TEMPLATE ${template}`);
    const c = connect(name);
    await c.connect();
    clones.push(c);
    return c;
  };
  const clone = (name: string): Promise<pg.Client> => cloneFrom(templateDb, name);

  const buildTemplate = async (
    name: string,
    o: { omit?: string[]; vaultServiceRoleKey?: string | null } = {},
  ): Promise<void> => {
    const skip = new Set(o.omit ?? []);
    await replayInto(
      name,
      all.slice(0, all.length - heldBack.length).filter((f) => !skip.has(f)),
      o.vaultServiceRoleKey === undefined ? opts.vaultServiceRoleKey : o.vaultServiceRoleKey,
    );
  };

  const shutdown = async (): Promise<void> => {
    for (const c of clones) await c.end().catch(() => undefined);
    await admin.end().catch(() => undefined);
    await epg.stop().catch(() => undefined);
    for (const d of disposableDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  };

  return { templateDb, admin, connect, clone, cloneFrom, buildTemplate, heldBack, applyHeldBack, shutdown };
}

// ── The PostgREST wire shape ─────────────────────────────────────────────────────────────────

/**
 * Render a row the way PostgREST renders it, so browser-side decoders are exercised against the
 * shapes the browser ACTUALLY receives.
 *
 * `pg` and PostgREST agree on every JSON scalar and disagree on exactly two types:
 *   `bytea`       — PostgREST emits PostgreSQL's `hex` text output, `"\\x<hex>"`; `pg` emits a Buffer.
 *   `timestamptz` — PostgREST emits an ISO 8601 string; `pg` emits a `Date`.
 *
 * THE CONVERSION GOES THIS WAY ROUND ON PURPOSE. The alternative — teaching the browser contract to
 * accept a `Date` — would loosen a production contract to suit a test harness, and would make the
 * decoders stop refusing a shape the browser can never legitimately receive.
 */
export function postgrestShape(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v instanceof Uint8Array) out[k] = `\\x${Buffer.from(v).toString('hex')}`;
    else if (v instanceof Date) out[k] = v.toISOString();
    else out[k] = v;
  }
  return out;
}

export const postgrestRows = (rows: Record<string, unknown>[]): Record<string, unknown>[] =>
  rows.map(postgrestShape);

// ── Fixture helpers ──────────────────────────────────────────────────────────────────────────

/**
 * A player account, created the way production creates one.
 *
 * `profiles.user_id` is NOT NULL and references `auth.users`, and the shipped `on_auth_user_created`
 * trigger mints exactly one profile per user — so a profile cannot be inserted directly at all.
 * Every account subject in the D7 evidence therefore comes from an auth user, and the id returned
 * is the id the product itself assigned.
 *
 * The profile read is a SEPARATE statement on purpose: the trigger writes the profiles as part of
 * the INSERT, and a data-modifying CTE's side effects are not visible to the rest of its own
 * statement — a single-statement version silently returns nothing.
 */
export async function newProfileIds(client: pg.Client, ids: string[]): Promise<string[]> {
  await client.query(`INSERT INTO auth.users(id) SELECT unnest($1::uuid[])`, [ids]);
  const { rows } = await client.query(
    `SELECT p.id FROM public.profiles p
       JOIN unnest($1::uuid[]) WITH ORDINALITY AS u(uid, ord) ON u.uid = p.user_id
      ORDER BY u.ord`,
    [ids],
  );
  if (rows.length !== ids.length) {
    throw new Error(`expected ${ids.length} minted profiles, got ${rows.length}`);
  }
  return rows.map((r) => r.id as string);
}

/**
 * Run `fn` with the session presenting a PostgREST-shaped JWT for `userId` under the
 * `authenticated` role, then restore the session.
 *
 * The GUC is set with `set_config(..., false)` — SESSION scope, not transaction scope — because a
 * wrapper reads it inside its own statement and a local setting would be invisible to a call made
 * outside an explicit transaction. `auth.uid()` in the platform shim is Supabase's real definition,
 * so this is the same path production takes.
 */
export async function asActor<T>(
  client: pg.Client,
  userId: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query(`SELECT set_config('request.jwt.claims', $1, false)`,
    [userId === null ? '' : JSON.stringify({ sub: userId, role: 'authenticated' })]);
  await client.query('SET ROLE authenticated');
  try {
    return await fn();
  } finally {
    await client.query('RESET ROLE');
    await client.query(`SELECT set_config('request.jwt.claims', '', false)`);
  }
}

// ── THE INSTALLED-CATALOG AUTHORITY ──────────────────────────────────────────────────────────
//
// WHY THIS EXISTS AND WHAT IT REPLACES. Every earlier version of the post-ABC-27 composition proof
// read MIGRATION SOURCE TEXT: a regex found `CREATE OR REPLACE FUNCTION public.<name>(`, another
// swept for `GRANT`/`REVOKE`/`ALTER FUNCTION`, and a third read back the string literals a
// comment-stripper had erased, looking for dynamic DDL. Each patch closed the bypass in front of it
// and left the next one open, because a scanner is a parser and the thing it is parsing is a
// language with more spellings than any denylist can hold:
//
//   • `CREATE PROCEDURE public.<name>(…)` — a routine the FUNCTION-only sweep never saw.
//   • `public.U&"abc27\005Fp\005Flive\005Feligibility"` — PostgreSQL decodes the Unicode escapes to
//     the protected name; a `\b<name>\b` scan matches nothing at all.
//   • `format('CREATE FUNCTION public.%I(…) … AS %L', '<name>', '…')` — the verb and the name live
//     in different literals, so no single literal ever carries both.
//
// None of those is exotic; all three are ordinary PostgreSQL. The fix is not a longer denylist. It
// is to stop reading the source and read the CATALOG the source produced: whatever spelling created
// a routine, `pg_proc` holds one folded name, one argument list, one owner, one ACL and one
// canonical definition for it. A catalog diff cannot be out-spelled.
//
// FAIL-CLOSED BY CONSTRUCTION. The snapshot is the WHOLE `public` routine population, not a
// curated list, so a surface nobody thought to name still appears in it — which is exactly the case
// the source scanners could not cover.

/**
 * A generic keyed catalog snapshot: `key -> a stable JSON rendering of everything else in the row`.
 *
 * The routine snapshot above is typed because its fields are reasoned about individually. These are
 * not: what matters for a relation, a column, a policy or a trigger is that NOTHING about it moved,
 * so the whole row is one comparable value and a diff names the key that changed.
 */
export async function catalogObjects(
  client: pg.Client, sql: string,
): Promise<Map<string, string>> {
  const { rows } = await client.query(sql);
  const out = new Map<string, string>();
  for (const r of rows) {
    const { key, ...rest } = r as Record<string, unknown>;
    if (typeof key !== 'string') throw new Error('catalogObjects: every row must carry a text `key`');
    if (out.has(key)) throw new Error(`catalogObjects: duplicate key ${key}`);
    out.set(key, JSON.stringify(rest));
  }
  return out;
}

export interface ObjectDiff {
  added: string[];
  removed: string[];
  /** The KEYS whose value moved — comparable against an expected list. */
  changed: string[];
  /** The same changes with before and after spelled out, so a failure says what moved. */
  detail: string[];
}

export function diffObjects(before: Map<string, string>, after: Map<string, string>): ObjectDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const detail: string[] = [];
  for (const [k, v] of before) {
    const a = after.get(k);
    if (a === undefined) removed.push(k);
    else if (a !== v) { changed.push(k); detail.push(`${k} :: ${v} -> ${a}`); }
  }
  for (const k of after.keys()) if (!before.has(k)) added.push(k);
  return {
    added: added.sort(), removed: removed.sort(), changed: changed.sort(), detail: detail.sort(),
  };
}

/**
 * The ACL of one object, EXPLODED and fully rendered: grantee, privilege, grant option AND grantor.
 *
 * Rendering it as `proacl::text` compares an ordered array and calls a reordering a change; rendering
 * only grantee+privilege calls `WITH GRANT OPTION` and a change of grantor no change at all. Both
 * are wrong in the direction that matters, so every ACL below is exploded and carries all four
 * parts. The owner's own name is folded to `<owner>` on BOTH sides of the arrow, so an install whose
 * owner role is named differently is not read as a privilege difference — the owner itself is
 * compared separately, so folding it here hides nothing.
 */
const ACL_SQL = (aclExpr: string, kind: string, ownerExpr: string) => `
  (SELECT coalesce(array_agg(
            -- FOLDED BY EQUALITY, NOT BY SUBSTRING REPLACE: replace() would also rewrite a
            -- DIFFERENT role whose name merely contains the owner's, which is a collision waiting
            -- for a role naming convention to arrive.
            CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                 WHEN a.grantee = ${ownerExpr} THEN '<owner>'
                 ELSE a.grantee::regrole::text END
            || '=' || a.privilege_type || '/' || a.is_grantable::text
            || '<-' || CASE WHEN a.grantor = ${ownerExpr} THEN '<owner>'
                            ELSE a.grantor::regrole::text END
            ORDER BY 1), '{}')
     FROM aclexplode(coalesce(${aclExpr}, pg_catalog.acldefault('${kind}', ${ownerExpr}))) a)`;

/** The schemas this release's objects live in. System schemas are excluded and named. */
const USER_SCHEMAS = `n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
                      AND n.nspname NOT LIKE 'pg\\_temp\\_%' AND n.nspname NOT LIKE 'pg\\_toast\\_temp\\_%'`;

/**
 * EVERY routine in EVERY user schema, with its full shape and canonical definition.
 *
 * NOT just `public`: replacing `auth.uid()` changes authorization semantics everywhere and would be
 * invisible to a `public`-only snapshot. Aggregates are excluded here because
 * `pg_get_functiondef` RAISES for them; `AGGREGATE_PROBE` tracks their identity separately, so the
 * exclusion narrows what is rendered and never what is seen.
 */
export const ROUTINE_SHAPE_PROBE = `
  SELECT n.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' AS key,
         p.prokind::text                                           AS prokind,
         p.prolang::regprocedure::text                             AS lang,
         pg_catalog.pg_get_function_result(p.oid)                  AS result,
         pg_catalog.pg_get_function_arguments(p.oid)               AS arguments_with_defaults,
         p.proowner::regrole::name                                 AS owner,
         ${ACL_SQL('p.proacl', 'f', 'p.proowner')}                 AS acl,
         p.prosecdef, p.provolatile::text, p.proleakproof, p.proisstrict,
         p.proparallel::text, p.proretset, p.pronargdefaults,
         p.procost, p.prorows, coalesce(p.prosupport::text, '<none>') AS support,
         coalesce(p.proconfig::text, '<none>')                     AS config
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE ${USER_SCHEMAS} AND p.prokind IN ('f','p','w')`;

/**
 * The canonical DEFINITION of every renderable routine, hashed.
 *
 * SEPARATE FROM THE SHAPE ON PURPOSE. `pg_get_functiondef` folds the body AND every modifier into
 * one string, so a `STRICT` added to a routine whose body this release is authorised to change
 * would be swallowed by an already-expected hash difference. Splitting them means the modifiers are
 * compared by the shape probe — where NOTHING may change — and the hash is left to say only what it
 * is trusted for: that some part of the definition of exactly these two routines differs.
 */
export const ROUTINE_DEF_PROBE = `
  SELECT n.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' AS key,
         encode(pg_catalog.sha256(
                  pg_catalog.convert_to(pg_catalog.pg_get_functiondef(p.oid), 'UTF8')), 'hex') AS def_sha
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE ${USER_SCHEMAS} AND p.prokind IN ('f','p','w')`;

/** Aggregate identities, tracked separately because their definition cannot be rendered. */
export const AGGREGATE_PROBE = `
  SELECT n.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' AS key,
         p.proowner::regrole::name AS owner, ${ACL_SQL('p.proacl', 'f', 'p.proowner')} AS acl
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE ${USER_SCHEMAS} AND p.prokind = 'a'`;

/** Every relation in every user schema: kind, owner, RLS, ACL, persistence, options, identity. */
export const RELATION_PROBE = `
  SELECT n.nspname || '.' || c.relname                     AS key,
         c.relkind::text                                   AS relkind,
         -- THE IDENTITY, NOT JUST THE NAME. The two databases compared here are TEMPLATE clones of
         -- ONE replayed template, so every relation that existed before the clone carries the SAME
         -- oid in both.
         -- A drop-and-recreate under the same name keeps every other field in this row identical
         -- and cannot keep this one.
         c.oid::text                                       AS identity,
         c.relowner::regrole::name                         AS owner,
         c.relrowsecurity, c.relforcerowsecurity,
         c.relpersistence::text, c.relreplident::text, c.relispartition,
         coalesce(pg_catalog.pg_get_expr(c.relpartbound, c.oid), '<none>') AS partition_bound,
         coalesce(c.reloptions::text, '<none>')            AS options,
         ${ACL_SQL('c.relacl', 'r', 'c.relowner')}         AS acl
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE ${USER_SCHEMAS}`;

/**
 * Every user column, with its type, nullability, default, identity/generation — AND ITS OWN ACL.
 *
 * `attacl` is the field this probe exists for. `GRANT SELECT (destination_normalized) ON
 * public.notification_outbox TO authenticated` moves NOTHING in `relacl`, nothing in any routine,
 * and nothing in any privilege matrix over functions — and it exposes a raw contact destination the
 * schema documents as service-role-only.
 */
export const COLUMN_PROBE = `
  SELECT n.nspname || '.' || c.relname || '.' || a.attname  AS key,
         -- attnum IS THE POINT OF THIS FIELD. A DROP COLUMN followed by an ADD COLUMN of the
         -- same name and type renders identically in every other column field while erasing every
         -- value the column held. The re-added column gets a NEW attnum.
         a.attnum,
         pg_catalog.format_type(a.atttypid, a.atttypmod)    AS type,
         a.attnotnull,
         coalesce(pg_catalog.pg_get_expr(d.adbin, d.adrelid), '<none>') AS default_expr,
         a.attidentity::text, a.attgenerated::text,
         coalesce(co.collname, '<none>')                    AS collation,
         ${ACL_SQL('a.attacl', 'c', 'c.relowner')}          AS acl
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    LEFT JOIN pg_catalog.pg_collation co ON co.oid = a.attcollation
   WHERE ${USER_SCHEMAS} AND a.attnum > 0 AND NOT a.attisdropped
     AND c.relkind IN ('r','p','v','m','f')`;

/** Every RLS policy, rendered by the server. */
export const POLICY_PROBE = `
  SELECT p.schemaname || '.' || p.tablename || '.' || p.policyname AS key,
         p.permissive, p.roles::text, p.cmd, p.qual, p.with_check
    FROM pg_catalog.pg_policies p
   WHERE p.schemaname NOT IN ('pg_catalog','information_schema')`;

/** Every non-internal trigger, with its enabled state and full definition. */
export const TRIGGER_PROBE = `
  SELECT n.nspname || '.' || c.relname || '.' || t.tgname  AS key,
         t.tgenabled::text                                 AS enabled,
         pg_catalog.pg_get_triggerdef(t.oid)               AS definition
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE ${USER_SCHEMAS} AND NOT t.tgisinternal`;

/**
 * EVERY index, not just the one this release adds — definition, uniqueness, validity, predicate.
 *
 * Dropping `uq_notification_outbox_idem` and recreating a same-named NON-unique index leaves the
 * relation probe's row identical: same name, same kind, same owner. Only this probe sees it.
 */
export const INDEX_PROBE = `
  SELECT n.nspname || '.' || ic.relname                    AS key,
         i.indrelid::regclass::text                        AS on_relation,
         i.indisunique, i.indisprimary, i.indisexclusion,
         i.indisvalid, i.indisready, i.indislive,
         pg_catalog.pg_get_indexdef(i.indexrelid)          AS definition,
         coalesce(pg_catalog.pg_get_expr(i.indpred, i.indrelid), '<none>') AS predicate
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = ic.relnamespace
   WHERE ${USER_SCHEMAS}`;

/** Every constraint, rendered by the server, with its validated flag. */
export const CONSTRAINT_PROBE = `
  SELECT n.nspname || '.'
         || coalesce(cl.relname, ty.typname, '<none>') || '.' || con.conname AS key,
         con.contype::text, con.convalidated, con.condeferrable, con.condeferred,
         pg_catalog.pg_get_constraintdef(con.oid)          AS definition
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_namespace n ON n.oid = con.connamespace
    LEFT JOIN pg_catalog.pg_class cl ON cl.oid = con.conrelid
    LEFT JOIN pg_catalog.pg_type  ty ON ty.oid = con.contypid
   WHERE ${USER_SCHEMAS}`;

/**
 * Event triggers, which are CLUSTER-visible and intercept future DDL.
 *
 * An event trigger installed by a migration runs on every later `CREATE`/`ALTER`/`DROP` in the
 * database and can rewrite or refuse it. Nothing in an object-by-object diff sees one arrive,
 * because it is not attached to any of the objects being compared.
 */
export const EVENT_TRIGGER_PROBE = `
  SELECT e.evtname                                         AS key,
         e.evtevent, e.evtowner::regrole::name             AS owner,
         e.evtenabled::text, e.evtfoid::regprocedure::text AS handler,
         coalesce(e.evttags::text, '<all>')                AS tags
    FROM pg_catalog.pg_event_trigger e`;

/** Installed extensions, their versions and the schemas they live in. */
export const EXTENSION_PROBE = `
  SELECT e.extname                                         AS key,
         e.extversion, e.extrelocatable,
         coalesce(n.nspname, '<none>')                     AS schema,
         e.extowner::regrole::name                         AS owner
    FROM pg_catalog.pg_extension e
    LEFT JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace`;

/**
 * Every view and materialized view definition.
 *
 * Re-creating `public.profiles_public` with the same columns and options but WITHOUT its `WHERE`
 * leaves relation, column and policy probes identical, and reinstates a GDPR enumeration defect
 * this codebase has already had once.
 */
export const VIEW_PROBE = `
  SELECT n.nspname || '.' || c.relname                     AS key,
         pg_catalog.pg_get_viewdef(c.oid, true)            AS definition,
         c.relkind::text                                   AS relkind
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE ${USER_SCHEMAS} AND c.relkind IN ('v','m')`;

/**
 * Roles, their attributes and their memberships.
 *
 * `ALTER ROLE authenticated BYPASSRLS`, or a new login granted the Domain-A owner role, leaves every
 * object probe above untouched and changes who can read everything.
 */
export const ROLE_PROBE = `
  SELECT r.rolname                                         AS key,
         r.rolsuper, r.rolinherit, r.rolcreaterole, r.rolcreatedb, r.rolcanlogin,
         r.rolreplication, r.rolbypassrls, r.rolconnlimit,
         -- A future-dated VALID UNTIL passes every check today and locks the role out later.
         coalesce(r.rolvaliduntil::text, '<never>')        AS valid_until,
         (r.rolpassword IS NOT NULL)                       AS has_password,
         -- EVERY membership option, not just ADMIN. Since PostgreSQL 16 a membership carries
         -- INHERIT and SET independently, and SET alone is enough to become the owner role.
         (SELECT coalesce(array_agg(m.roleid::regrole::text
                          || '/admin=' || m.admin_option::text
                          || '/inherit=' || m.inherit_option::text
                          || '/set=' || m.set_option::text
                          || '/by=' || m.grantor::regrole::text ORDER BY 1), '{}')
            FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid) AS member_of
    FROM pg_catalog.pg_roles r`;

/**
 * PER-ROLE AND PER-DATABASE SESSION SETTINGS — `ALTER ROLE … SET` and `ALTER DATABASE … SET`.
 *
 * This is the probe that guards the linearization contract from OUTSIDE the function. Setting
 * `default_transaction_isolation = 'repeatable read'` for the dispatcher's role changes every
 * future session so that a VOLATILE function's statements reuse ONE snapshot — and the re-read that
 * this whole release is built on would then faithfully report eligibility as it stood before the
 * payment. It touches no routine, no relation, no column, no policy, no ACL and no role attribute:
 * every other probe in this file stays green. `search_path`, `role`, `statement_timeout` and
 * `session_replication_role` live here too, and each of them changes behaviour the same way.
 */
export const DB_ROLE_SETTING_PROBE = `
  SELECT coalesce(d.datname, '<all databases>') || '/' || coalesce(r.rolname, '<all roles>') AS key,
         s.setconfig::text                                 AS settings
    FROM pg_catalog.pg_db_role_setting s
    LEFT JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase
    LEFT JOIN pg_catalog.pg_roles r ON r.oid = s.setrole`;

/** Schema ownership and ACLs — including CREATE, which is the right to put a routine back. */
export const SCHEMA_PROBE = `
  SELECT n.nspname                                         AS key,
         n.nspowner::regrole::name                         AS owner,
         ${ACL_SQL('n.nspacl', 'n', 'n.nspowner')}         AS acl
    FROM pg_catalog.pg_namespace n
   WHERE ${USER_SCHEMAS}`;

/** Default privileges — a grant that applies to objects that do not exist yet. */
export const DEFAULT_ACL_PROBE = `
  SELECT coalesce(n.nspname, '<all>') || '.' || d.defaclrole::regrole::text || '.' || d.defaclobjtype::text AS key,
         d.defaclacl::text                                 AS acl
    FROM pg_catalog.pg_default_acl d
    LEFT JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace`;

/**
 * ARM A STATEMENT-LEVEL DML WITNESS ON EVERY USER TABLE.
 *
 * NO CATALOG DIFF CAN SEE A `DELETE`. A guarded post-ABC-27 migration could run
 * `DELETE FROM public.notification_outbox` and leave every routine, relation, column, policy,
 * trigger, index, constraint, view, role and privilege diff perfectly green, while production loses
 * durable dispatch and audit history.
 *
 * STATISTICS COUNTERS ARE NOT ENOUGH EITHER, and the reason is the whole point of this function: on
 * a clean replay database the tables are EMPTY, so `DELETE FROM …` removes nothing and
 * `pg_stat_all_tables.n_tup_del` never moves. The dangerous statement leaves no trace precisely
 * because the evidence database has no data to lose.
 *
 * A STATEMENT-level trigger fires once per statement whatever the row count — including zero — and
 * `TRUNCATE` fires one too. So arming one on every ordinary table turns "these files write no data"
 * into a measurement that does not depend on the fixture having rows.
 *
 * This mutates the database it is called on, so it is only ever used on a disposable clone whose
 * catalog nothing else compares.
 */
export async function armDmlWitness(client: pg.Client): Promise<number> {
  await client.query(`
    CREATE TABLE public.d7_dml_witness (
      id bigserial PRIMARY KEY, rel text NOT NULL, op text NOT NULL);
    CREATE FUNCTION public.d7_dml_witness_fn() RETURNS trigger
    LANGUAGE plpgsql AS $wit$
    BEGIN
      INSERT INTO public.d7_dml_witness(rel, op)
      VALUES (TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, TG_OP);
      RETURN NULL;
    END $wit$;`);
  // EVERY ordinary and partitioned table in every user schema, the witness table itself excluded.
  const { rows } = await client.query(`
    SELECT n.nspname AS s, c.relname AS t
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE ${USER_SCHEMAS} AND c.relkind IN ('r','p')
       AND NOT (n.nspname = 'public' AND c.relname = 'd7_dml_witness')
     ORDER BY 1, 2`);
  for (const r of rows) {
    // `ENABLE ALWAYS` so the witness fires even if a migration sets `session_replication_role`.
    await client.query(
      `CREATE TRIGGER zzz_d7_dml_witness AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE `
      + `ON "${r.s}"."${r.t}" FOR EACH STATEMENT EXECUTE FUNCTION public.d7_dml_witness_fn()`);
    await client.query(`ALTER TABLE "${r.s}"."${r.t}" ENABLE ALWAYS TRIGGER zzz_d7_dml_witness`);
  }
  return rows.length;
}

/** What the witness saw, as `schema.table/OP` counts. */
export async function readDmlWitness(client: pg.Client): Promise<string[]> {
  const { rows } = await client.query(`
    SELECT rel || '/' || op || ' x' || count(*)::text AS seen
      FROM public.d7_dml_witness GROUP BY rel, op ORDER BY 1`);
  return rows.map((r) => r.seen as string);
}

/**
 * EVERY rewrite rule, not just the ones that happen to be views.
 *
 * `CREATE RULE … ON INSERT TO t DO INSTEAD …` silently redirects writes to another relation. It
 * attaches to no column, adds no trigger, changes no ACL and leaves `pg_get_viewdef` empty for an
 * ordinary table — so nothing else in this file would see one arrive. It is the one rewrite surface
 * a view-only probe misses.
 */
export const RULE_PROBE = `
  SELECT n.nspname || '.' || c.relname || '.' || r.rulename AS key,
         r.ev_type::text                                    AS event,
         r.is_instead,
         pg_catalog.pg_get_ruledef(r.oid, true)             AS definition
    FROM pg_catalog.pg_rewrite r
    JOIN pg_catalog.pg_class c ON c.oid = r.ev_class
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE ${USER_SCHEMAS}`;

/**
 * Enum labels, in order.
 *
 * A closed vocabulary is a boundary in this codebase — transport states, dispositions and terminal
 * outcomes are all enumerations, and a label added to one silently widens what a column may hold.
 * The ones implemented as CHECK constraints are covered by `CONSTRAINT_PROBE`; these are the rest.
 */
export const ENUM_PROBE = `
  SELECT n.nspname || '.' || t.typname                     AS key,
         (SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder)
            FROM pg_catalog.pg_enum e WHERE e.enumtypid = t.oid) AS labels,
         t.typowner::regrole::name                         AS owner,
         ${ACL_SQL('t.typacl', 'T', 't.typowner')}         AS acl
    FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
   WHERE ${USER_SCHEMAS} AND t.typtype = 'e'`;

/** Logical-replication publications: what leaves this database, and for which operations. */
export const PUBLICATION_PROBE = `
  SELECT p.pubname                                         AS key,
         p.pubowner::regrole::name                         AS owner,
         p.puballtables, p.pubinsert, p.pubupdate, p.pubdelete, p.pubtruncate, p.pubviaroot,
         (SELECT coalesce(array_agg(pr.prrelid::regclass::text
                          || '/' || coalesce(pg_catalog.pg_get_expr(pr.prqual, pr.prrelid), '<all rows>')
                          || '/' || coalesce(pr.prattrs::text, '<all columns>') ORDER BY 1), '{}')
            FROM pg_catalog.pg_publication_rel pr WHERE pr.prpubid = p.oid) AS tables,
         -- WHOLE-SCHEMA MEMBERSHIP LIVES IN A DIFFERENT CATALOG. ALTER PUBLICATION …
         -- ADD TABLES IN SCHEMA public writes pg_publication_namespace and leaves
         -- pg_publication_rel untouched, while every current AND future table in that schema
         -- starts being replicated out.
         (SELECT coalesce(array_agg(pn.pnnspid::regnamespace::text ORDER BY 1), '{}')
            FROM pg_catalog.pg_publication_namespace pn WHERE pn.pnpubid = p.oid) AS schemas
    FROM pg_catalog.pg_publication p`;

/**
 * ARM AN EVENT-TRIGGER DDL CENSUS.
 *
 * ENDPOINT EQUALITY IS NOT THE SAME AS "NOTHING HAPPENED". Two catalogs can be identical at the end
 * of an apply that did something dangerous in the middle: disable a trigger, delete history,
 * re-enable it; drop a unique index, write duplicates, recreate it; grant a privilege, act on it,
 * revoke it. Every one of those leaves a final catalog that a diff calls unchanged.
 *
 * `ddl_command_end` and `sql_drop` fire on the statements themselves, so the census records the
 * ACTIONS rather than their residue. Armed AFTER the DML witness so it does not record the witness
 * being installed.
 */
export async function armDdlWitness(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE public.d7_ddl_witness (id bigserial PRIMARY KEY, tag text NOT NULL, obj text NOT NULL);
    CREATE FUNCTION public.d7_ddl_witness_fn() RETURNS event_trigger LANGUAGE plpgsql AS $ddl$
    DECLARE r record;
    BEGIN
      FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
        INSERT INTO public.d7_ddl_witness(tag, obj)
        VALUES (r.command_tag, coalesce(r.object_identity, '<none>'));
      END LOOP;
    END $ddl$;
    CREATE FUNCTION public.d7_drop_witness_fn() RETURNS event_trigger LANGUAGE plpgsql AS $drp$
    DECLARE r record;
    BEGIN
      FOR r IN SELECT * FROM pg_event_trigger_dropped_objects() LOOP
        INSERT INTO public.d7_ddl_witness(tag, obj)
        VALUES ('DROP ' || r.object_type, coalesce(r.object_identity, '<none>'));
      END LOOP;
    END $drp$;
    CREATE EVENT TRIGGER d7_ddl_witness_trg ON ddl_command_end
      EXECUTE FUNCTION public.d7_ddl_witness_fn();
    CREATE EVENT TRIGGER d7_drop_witness_trg ON sql_drop
      EXECUTE FUNCTION public.d7_drop_witness_fn();`);
}

/** Every DDL action the census saw, as `TAG obj`, in execution order. */
export async function readDdlWitness(client: pg.Client): Promise<string[]> {
  const { rows } = await client.query(
    `SELECT tag || ' ' || obj AS seen FROM public.d7_ddl_witness ORDER BY id`);
  return rows.map((r) => r.seen as string);
}

/**
 * ROUTINES IN THE SYSTEM SCHEMAS.
 *
 * `USER_SCHEMAS` excludes `pg_catalog` deliberately — it is where PostgreSQL itself lives and it is
 * not this release's surface. But a superuser migration CAN create or replace a routine there, and
 * `begin_dispatch` calls `clock_timestamp()` and `current_setting()` unqualified: with
 * `SET search_path = public`, `pg_catalog` is still resolved implicitly and first. So a replacement
 * of one of those would change what the fences measure without touching any probe above.
 *
 * Definitions only. Ownership and ACL of the system catalog are PostgreSQL's business.
 */
export const SYSTEM_ROUTINE_PROBE = `
  SELECT n.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' AS key,
         encode(pg_catalog.sha256(
                  pg_catalog.convert_to(pg_catalog.pg_get_functiondef(p.oid), 'UTF8')), 'hex') AS def_sha
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('pg_catalog', 'information_schema') AND p.prokind IN ('f','p','w')`;

/**
 * The database's own settings: who may connect, and how many.
 *
 * `REVOKE CONNECT ON DATABASE … FROM PUBLIC` and `ALTER DATABASE … CONNECTION LIMIT 0` are outages
 * that leave every object in the database exactly as it was. `pg_database` is shared, so this is
 * compared from the before-any-apply snapshot with the rest of the shared catalogs.
 *
 * ONLY THE CURRENT DATABASE'S ROW, KEYED CONSTANTLY. The evidence harness creates and drops clones
 * of its own throughout a run, so comparing the whole catalog would report the test framework's
 * bookkeeping as a migration effect — noise that would eventually be silenced rather than read.
 */
export const DATABASE_PROBE = `
  SELECT '<this database>'                                 AS key,
         d.datdba::regrole::name                           AS owner,
         d.datallowconn, d.datconnlimit, d.datistemplate,
         ${ACL_SQL('d.datacl', 'd', 'd.datdba')}           AS acl
    FROM pg_catalog.pg_database d
   WHERE d.datname = current_database()`;

/** Per-parameter GRANTs — the right to SET a normally superuser-only GUC. */
export const PARAMETER_ACL_PROBE = `
  SELECT pa.parname                                        AS key,
         pa.paracl::text                                   AS acl
    FROM pg_catalog.pg_parameter_acl pa`;

/**
 * Sequence definitions AND their current value.
 *
 * Not "physical metadata": a low `MAXVALUE` with `CYCLE` on an audit table's identity sequence
 * makes future inserts wrap and collide on the primary key, long after every catalog comparison
 * has gone green.
 */
export const SEQUENCE_PROBE = `
  SELECT n.nspname || '.' || c.relname                     AS key,
         sq.seqtypid::regtype::text                        AS type,
         sq.seqstart, sq.seqincrement, sq.seqmax, sq.seqmin, sq.seqcache, sq.seqcycle
    FROM pg_catalog.pg_sequence sq
    JOIN pg_catalog.pg_class c ON c.oid = sq.seqrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE ${USER_SCHEMAS}`;
