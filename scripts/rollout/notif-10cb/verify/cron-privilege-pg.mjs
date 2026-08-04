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

// LOOPBACK ONLY, ASSERTED — not assumed. This script SCHEDULES throwaway cron jobs, and the hosted
// production database would satisfy every role/ownership check below (that is the point of them),
// so a stale SUPABASE_LOCAL_DB_URL pointing anywhere real would turn a rehearsal into a production
// write. The URL must be url-form (libpq's keyword/value form parses "somewhere else entirely" —
// see the 10c-b README on conninfo), carry NO QUERY STRING (pg-connection-string lets `?host=…`
// OVERRIDE the authority's hostname, so a loopback-looking url with a query can connect anywhere —
// the production dispatcher refuses query strings outright for the same reason), no whitespace or
// control characters, no multi-host list, and resolve to a loopback host. Errors below never echo
// the URL: it carries a password.
const notLoopbackBecause = (raw) => {
  if (!/^postgres(ql)?:\/\//.test(raw)) return 'must be a postgresql:// url (keyword/value conninfo parses somewhere else entirely)';
  if (/[\s\x00-\x1f]/.test(raw)) return 'carries whitespace or control characters';
  if (raw.includes('?')) return 'carries a query string (a ?host= override connects elsewhere while the authority reads loopback)';
  let u;
  try { u = new URL(raw); } catch { return 'does not parse as a url'; }
  if (raw.split('@').pop().includes(',')) return 'carries a multi-host list — one loopback host only';
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname)) {
    return `must point at a loopback host (got ${u.hostname}) — this rehearsal schedules real cron jobs and must never see a remote database`;
  }
  return null;
};
const loopbackOnly = (raw, name) => {
  const why = notLoopbackBecause(raw);
  if (why) { console.error(`${name} ${why}`); process.exit(1); }
  const u = new URL(raw);
  return { raw, label: `${u.hostname}:${u.port || 5432}` };
};
const DB = loopbackOnly(process.env.SUPABASE_LOCAL_DB_URL
  ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres', 'SUPABASE_LOCAL_DB_URL');
// supabase_admin exists only to prove the FOREIGN-owner refusal; same local password.
const ADMIN = loopbackOnly(process.env.SUPABASE_LOCAL_ADMIN_DB_URL
  ?? 'postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres', 'SUPABASE_LOCAL_ADMIN_DB_URL');

const JOB = `n0-priv-rehearsal-${process.pid}`;
const FOREIGN_JOB = `${JOB}-foreign`;

let PASS = 0, FAIL = 0;
const rec = (n, ok, d = '') => {
  const l = `  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`;
  (ok ? console.log : console.error)(l);
  ok ? PASS++ : FAIL++;
};

const c = new pg.Client({ connectionString: DB.raw });
try {
  await c.connect();
} catch (e) {
  // the URL is never echoed — it carries a password; the host:port is enough to act on
  console.error(`cannot reach the Supabase local stack at ${DB.label}: ${e.code ?? e.message}`);
  console.error('start it with `supabase start` (CI does this in rollout-tooling.yml) and re-run.');
  process.exit(1);
}

const b = new pg.Client({ connectionString: DB.raw });   // the concurrent-writer session
await b.connect();
let admin = null;

const errOf = async (client, sql, params = []) => {
  try { await client.query(sql, params); return null; } catch (e) { return e; }
};

console.log('\n10c-b N0 — the job-row lock against REAL pg_cron on the local Supabase stack\n');

try {
  // ── the loopback guard's own mutation pins ──────────────────────────────
  // The guard is what stands between a stale env var and a production write, so its refusals are
  // asserted here rather than trusted: weaken one arm and this goes red.
  for (const [bad, why] of [
    ['postgresql://u:p@db.example.supabase.co:5432/db', 'a remote host'],
    ['postgresql://u:p@127.0.0.1:5432/db?host=db.example.com', 'a ?host= query override'],
    ['host=db.example.com user=u dbname=db', 'keyword/value conninfo'],
    ['postgresql://u:p@127.0.0.1,db.example.com:5432/db', 'a multi-host list'],
    ['postgresql://u:p@127.0.0.1:5432/db\n', 'control characters'],
  ]) {
    rec(`the loopback guard refuses ${why}`, notLoopbackBecause(bad) !== null,
      notLoopbackBecause(bad) === null ? 'the guard let it through' : '');
  }

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
  // operator-scoped resolve must never see it as its own. This is the one arm only the REAL
  // extension can prove, so an unreachable supabase_admin is a FAILURE — reporting it as a pass
  // would let a CLI-image credential change silently delete the check while CI stays green. A
  // developer without the admin password can skip EXPLICITLY (the skip neither passes nor fails,
  // and CI never sets the variable).
  admin = new pg.Client({ connectionString: ADMIN.raw });
  let adminOk = true;
  try { await admin.connect(); } catch { adminOk = false; admin = null; }
  if (adminOk) {
    const fid = (await admin.query(
      `SELECT cron.schedule($1, '59 23 31 12 *', 'SELECT 1') AS id`, [FOREIGN_JOB])).rows[0].id;
    // BOTH connections must be looking at the SAME catalog, or "does not exist or you don't own
    // it" is ambiguous: two different loopback stacks would produce the same error for a jobid
    // that simply is not there, and the scenario would pass with no foreign row ever tested.
    const visible = (await c.query(
      `SELECT count(*)::int AS n FROM cron.job
        WHERE jobid = $1 AND jobname = $2 AND username = 'supabase_admin'`,
      [fid, FOREIGN_JOB])).rows[0].n;
    rec('the foreign job is visible to the operator connection in the SAME catalog', visible === 1,
      visible === 1 ? '' : 'the two URLs reach different stacks — the refusal below would be vacuous');
    // The check above GATES the alter, it does not merely report: under a two-stack mismatch the
    // foreign jobid can coincide with an unrelated job in the operator catalog, and the "refusal
    // probe" would then disarm a real local job.
    if (visible === 1) {
      const e = await errOf(c, `SELECT cron.alter_job($1, active := false)`, [fid]);
      rec("a FOREIGN-owned job raises ('you don't own it') for the operator role",
        !!e && /does not exist or you don't own it/.test(e.message), e?.message ?? 'it altered a foreign job');
      const seen = (await c.query(
        `SELECT count(*)::int AS n FROM cron.job WHERE jobname = $1 AND username = current_user`,
        [FOREIGN_JOB])).rows[0].n;
      rec('...and the owner-scoped resolve never claims it', seen === 0, `resolved=${seen}`);
    }
  } else if (process.env.CRON_PRIVILEGE_ALLOW_ADMIN_SKIP === '1') {
    console.log('  SKIP  foreign-owner arm — supabase_admin not reachable and the skip was EXPLICITLY requested');
  } else {
    rec('the foreign-owner arm requires supabase_admin over TCP', false,
      `supabase_admin not reachable at ${ADMIN.label} — set CRON_PRIVILEGE_ALLOW_ADMIN_SKIP=1 to skip locally; CI must never skip`);
  }
} finally {
  // Whatever failed above, no throwaway job may outlive the rehearsal — and a session that died
  // inside a transaction must be rolled back FIRST, or the cleanup itself aborts (25P02) / is
  // discarded with the connection. Cleanup is then VERIFIED, not assumed: a suppressed unschedule
  // failure would leave a job behind while the rehearsal exits zero.
  await c.query(`ROLLBACK`).catch(() => {});
  await b.query(`ROLLBACK`).catch(() => {});
  await admin?.query(`ROLLBACK`).catch(() => {});
  await c.query(`SELECT cron.unschedule($1)`, [JOB]).catch(() => {});
  await admin?.query(`SELECT cron.unschedule($1)`, [FOREIGN_JOB]).catch(() => {});
  // Each job is verified through the CONNECTION THAT OWNS ITS CATALOG: under the two-stack
  // mismatch the same-catalog gate detects, the operator connection cannot see a foreign job
  // stranded on the admin stack.
  try {
    const left = (await c.query(
      `SELECT array_agg(jobname) AS names FROM cron.job WHERE jobname IN ($1, $2)`,
      [JOB, FOREIGN_JOB])).rows[0].names ?? [];
    rec('no throwaway job outlives the rehearsal (operator catalog)', left.length === 0,
      left.length === 0 ? '' : `left behind: ${left.join(', ')} — remove by name before re-running`);
  } catch (e) {
    rec('no throwaway job outlives the rehearsal (operator catalog)', false,
      `could not VERIFY cleanup (${e.code ?? e.message}) — check cron.job for '${JOB}' by hand`);
  }
  if (admin) {
    try {
      const left = (await admin.query(
        `SELECT array_agg(jobname) AS names FROM cron.job WHERE jobname = $1`,
        [FOREIGN_JOB])).rows[0].names ?? [];
      rec('no throwaway job outlives the rehearsal (admin catalog)', left.length === 0,
        left.length === 0 ? '' : `left behind: ${left.join(', ')} — remove by name before re-running`);
    } catch (e) {
      rec('no throwaway job outlives the rehearsal (admin catalog)', false,
        `could not VERIFY cleanup (${e.code ?? e.message}) — check cron.job for '${FOREIGN_JOB}' by hand`);
    }
  }
  await admin?.end().catch(() => {});
  await b.end().catch(() => {});
  await c.end().catch(() => {});
}

console.log(`\n================  ${PASS} passed, ${FAIL} failed  ================\n`);
process.exit(FAIL === 0 ? 0 : 1);
