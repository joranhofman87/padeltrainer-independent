// ===========================================================================
// cron-privilege-pg.mjs — prove the job-row lock primitive against REAL pg_cron,
// under the REAL hosted privilege split.
//
// WHY THIS EXISTS ALONGSIDE preflight-pg.mjs. That harness models pg_cron 1.6.4's
// alter_job as a SECURITY DEFINER stand-in and models the supabase_admin/postgres
// split with roles it creates itself — a faithful model, but a model, and a model
// embodies the assumptions it was built from. This script runs the same claims
// against the Supabase local stack: real pg_cron, a real supabase_admin-owned
// cron.job, a real non-superuser `postgres`. It is what says the model is not a
// story we told ourselves — the first production run of `smoke-disabled` was
// refused by exactly the privilege fact a superuser-only harness cannot see.
//
// It needs the local stack (`supabase start`; CI provides it in
// .github/workflows/rollout-tooling.yml) and touches ONLY a throwaway job it
// creates and removes itself — never the real notification-digest-worker row.
// It is deliberately NOT part of `verify:rollout`, which must stay runnable
// without docker; the CI workflow runs it on every tooling change.
//
// Run: node scripts/rollout/notif-10cb/verify/cron-privilege-pg.mjs
// ===========================================================================
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(HERE, '..', 'sql');
const URL = process.env.SUPABASE_LOCAL_DB_URL
  ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
// supabase_admin exists only to prove the FOREIGN-owner refusal; same local password.
const ADMIN_URL = process.env.SUPABASE_LOCAL_ADMIN_DB_URL
  ?? 'postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres';

const JOB = `n0-priv-rehearsal-${process.pid}`;

let PASS = 0, FAIL = 0;
const rec = (n, ok, d = '') => {
  const l = `  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`;
  (ok ? console.log : console.error)(l);
  ok ? PASS++ : FAIL++;
};

const c = new pg.Client({ connectionString: URL });
try {
  await c.connect();
} catch (e) {
  console.error(`cannot reach the Supabase local stack at ${URL}: ${e.message}`);
  console.error('start it with `supabase start` (CI does this in rollout-tooling.yml) and re-run.');
  process.exit(1);
}

const b = new pg.Client({ connectionString: URL });   // the concurrent-writer session
await b.connect();
let admin = null;

const errOf = async (client, sql, params = []) => {
  try { await client.query(sql, params); return null; } catch (e) { return e; }
};

console.log('\n10c-b N0 — the job-row lock against REAL pg_cron on the local Supabase stack\n');

try {
  // ── the environment must BE the hosted privilege model, or nothing below counts ──
  const su = (await c.query(
    `SELECT usesuper FROM pg_user WHERE usename = current_user`)).rows[0]?.usesuper;
  rec('the connected postgres role is NOT a superuser (as hosted)', su === false,
    su === false ? '' : 'this stack does not model the hosted role — every later check is vacuous');
  const owner = (await c.query(
    `SELECT tableowner FROM pg_tables WHERE schemaname = 'cron' AND tablename = 'job'`)).rows[0]?.tableowner;
  rec('cron.job is owned by supabase_admin', owner === 'supabase_admin', `owner=${owner}`);
  const priv = (await c.query(`
    SELECT has_table_privilege(current_user, 'cron.job', 'SELECT') AS s,
           has_table_privilege(current_user, 'cron.job', 'UPDATE') AS u`)).rows[0];
  rec('...with SELECT granted and UPDATE withheld from the operator role',
    priv?.s === true && priv?.u === false, JSON.stringify(priv));
  const ver = (await c.query(
    `SELECT extversion FROM pg_extension WHERE extname = 'pg_cron'`)).rows[0]?.extversion;
  rec('pg_cron is installed', !!ver, `extversion=${ver}`);

  // The artifact's version pin and this stack must agree — the predicate is EXTRACTED from the
  // include rather than retyped, so a legitimate change there fails here instead of drifting.
  const gateLock = readFileSync(join(SQL_DIR, '_gate_job_lock.sql'), 'utf8');
  const pinExpr = gateLock.match(/SELECT (extversion = '[^']+' OR extversion LIKE '[^']+')\s*\n\s*FROM pg_extension/)?.[1];
  rec('the lock include still pins a pg_cron version', !!pinExpr, pinExpr ?? 'predicate not found');
  if (pinExpr) {
    const okv = (await c.query(
      `SELECT ${pinExpr} AS ok FROM pg_extension WHERE extname = 'pg_cron'`)).rows[0]?.ok;
    rec('...and the REAL pg_cron here satisfies that pin', okv === true, `extversion=${ver}`);
  }

  // ── the production refusal, reproduced on the real catalog ──────────────
  {
    const e = await errOf(c, `BEGIN`) ?? await errOf(c, `SELECT jobid FROM cron.job LIMIT 1 FOR UPDATE`);
    await c.query(`ROLLBACK`).catch(() => {});
    rec('FOR UPDATE on cron.job is refused (42501) — the production smoke refusal',
      e?.code === '42501', e ? `${e.code}: ${e.message}` : 'FOR UPDATE succeeded');
  }
  {
    const e = await errOf(c, `BEGIN`) ?? await errOf(c, `LOCK TABLE cron.job IN SHARE MODE`);
    await c.query(`ROLLBACK`).catch(() => {});
    rec('LOCK TABLE cron.job IN SHARE MODE is refused too', e?.code === '42501',
      e ? `${e.code}: ${e.message}` : 'LOCK TABLE succeeded');
  }

  // ── the throwaway job the lock semantics are proven on ──────────────────
  const jid = (await c.query(
    `SELECT cron.schedule($1, '59 23 31 12 *', 'SELECT 1') AS id`, [JOB])).rows[0].id;
  rec('a throwaway job was scheduled (never the real digest job)', !!jid, `jobid=${jid}`);

  {
    const e = await errOf(c, `SELECT cron.alter_job($1)`, [jid]);
    rec("an all-default alter_job is refused ('no updates specified') — there is NO pure no-op",
      !!e && /no updates specified/.test(e.message), e?.message ?? 'it succeeded');
  }

  // The guarded statement must not alter an ACTIVE job (cron.schedule arms by default).
  {
    const n = (await c.query(`
      SELECT count(*)::int AS n FROM (
        SELECT cron.alter_job(j.jobid, active := false)
          FROM cron.job j WHERE j.jobid = $1 AND j.active IS FALSE) s`, [jid])).rows[0].n;
    const still = (await c.query(`SELECT active FROM cron.job WHERE jobid = $1`, [jid])).rows[0].active;
    rec('the guarded lock statement matches NOTHING on an armed job and alters nothing',
      n === 0 && still === true, `locked=${n} active=${still}`);
  }
  await c.query(`SELECT cron.alter_job($1, active := false)`, [jid]);

  // ── the lock itself: held to transaction end, every cron writer queues behind it ──
  const xminBefore = (await c.query(
    `SELECT xmin::text AS x FROM cron.job WHERE jobid = $1`, [jid])).rows[0].x;
  await c.query(`BEGIN`);
  const locked = (await c.query(`
    SELECT count(*)::int AS n FROM (
      SELECT cron.alter_job(j.jobid, active := false)
        FROM cron.job j WHERE j.jobid = $1 AND j.active IS FALSE) s`, [jid])).rows[0].n;
  rec('the guarded lock statement locks exactly one inactive row', locked === 1, `locked=${locked}`);
  const wrote = (await c.query(
    `SELECT (j.xmin = pg_current_xact_id()::xid) AS ok FROM cron.job j WHERE j.jobid = $1`,
    [jid])).rows[0].ok;
  rec("the write-proof holds on real pg_cron (the row's xmin is THIS transaction)", wrote === true);

  await b.query(`SET lock_timeout = '1500ms'`);
  {
    const e = await errOf(b, `SELECT cron.alter_job($1, active := true)`, [jid]);
    rec('a concurrent arm through cron.alter_job BLOCKS behind the held lock', e?.code === '55P03',
      e ? `${e.code}: ${e.message}` : 'the concurrent arm went through');
  }
  {
    const e = await errOf(b, `SELECT cron.schedule($1, '58 23 31 12 *', 'SELECT 2')`, [JOB]);
    rec('a concurrent same-name schedule UPSERT blocks too', e?.code === '55P03',
      e ? `${e.code}: ${e.message}` : 'the upsert went through');
  }
  {
    const r = await b.query(`SELECT active FROM cron.job WHERE jobid = $1`, [jid]);
    rec('a plain reader is NOT blocked and sees the last committed state',
      r.rows[0]?.active === false, `active=${r.rows[0]?.active}`);
  }
  await c.query(`ROLLBACK`);
  {
    const after = (await c.query(
      `SELECT xmin::text AS x, active FROM cron.job WHERE jobid = $1`, [jid])).rows[0];
    rec('a rolled-back lock leaves the row byte-identical (xmin unchanged, still inactive)',
      after.x === xminBefore && after.active === false, `xmin ${xminBefore} -> ${after.x}`);
  }

  // ── fail-closed refusals from the API itself ────────────────────────────
  {
    const e = await errOf(c, `SELECT cron.alter_job(999999999, active := false)`);
    rec('a MISSING jobid raises rather than no-ops', !!e && /does not exist or you don't own it/.test(e.message),
      e?.message ?? 'it succeeded over nothing');
  }

  // A job owned by supabase_admin: the operator's alter must be refused by ownership, and the
  // operator-scoped resolve must never see it as its own.
  admin = new pg.Client({ connectionString: ADMIN_URL });
  let adminOk = true;
  try { await admin.connect(); } catch { adminOk = false; admin = null; }
  if (adminOk) {
    const fjob = `${JOB}-foreign`;
    const fid = (await admin.query(
      `SELECT cron.schedule($1, '59 23 31 12 *', 'SELECT 1') AS id`, [fjob])).rows[0].id;
    const e = await errOf(c, `SELECT cron.alter_job($1, active := false)`, [fid]);
    rec("a FOREIGN-owned job raises ('you don't own it') for the operator role",
      !!e && /does not exist or you don't own it/.test(e.message), e?.message ?? 'it altered a foreign job');
    const seen = (await c.query(
      `SELECT count(*)::int AS n FROM cron.job WHERE jobname = $1 AND username = current_user`,
      [fjob])).rows[0].n;
    rec('...and the owner-scoped resolve never claims it', seen === 0, `resolved=${seen}`);
    await admin.query(`SELECT cron.unschedule($1)`, [fjob]);
  } else {
    rec('foreign-owner arm SKIPPED — supabase_admin not reachable over TCP here', true,
      'covered by the modelled harness; CI stacks accept the same local password');
  }
} finally {
  // the throwaway job must not outlive the rehearsal, whatever failed above
  await c.query(`SELECT cron.unschedule($1)`, [JOB]).catch(() => {});
  await admin?.end().catch(() => {});
  await b.end().catch(() => {});
  await c.end().catch(() => {});
}

console.log(`\n================  ${PASS} passed, ${FAIL} failed  ================\n`);
process.exit(FAIL === 0 ? 0 : 1);
