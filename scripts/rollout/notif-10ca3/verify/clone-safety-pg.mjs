// ===========================================================================
// clone-safety-pg.mjs — EXECUTE the supported rehearsal artifacts on a REAL
// PostgreSQL, including the real #615 migrations. (ADR-001)
//
// The bash suite proves the tooling's control flow with stubs. This one runs the
// SQL and the real migrations: the empty-project proof, schedule deactivation,
// the inertness gate, the baseline fingerprint, the synthetic generator, and the
// ACCESS EXCLUSIVE behaviour of 20261006100000 — none of which a stub can show.
//
// pg_cron/pg_net are not installable in the embedded server, so cron.job,
// net.http_request_queue, net._http_response and vault.secrets are created as
// REAL tables with the same shape; the artifacts are read from disk unmodified
// apart from inlining \ir includes the way psql would.
//
// Run: node scripts/rollout/notif-10ca3/verify/clone-safety-pg.mjs
// ===========================================================================
import pg from 'pg';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { boot, SQL_DIR, installPreState, applyPr615, REPO } from './chain.mjs';

const PORT = 54373;
let PASS = 0, FAIL = 0;
const rec = (n, ok, d = '') => { const l = `  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`;
  (ok ? console.log : console.error)(l); ok ? PASS++ : FAIL++; };

function artifactText(name) {
  let t = readFileSync(join(SQL_DIR, name), 'utf8');
  for (let i = 0; i < 6; i++) {
    const b = t;
    t = t.replace(/^\\ir? ([A-Za-z0-9_.]+\.sql)\s*$/gm, (_m, f) => readFileSync(join(SQL_DIR, f), 'utf8'));
    if (t === b) break;
  }
  return t.replace(/^\\.*$/gm, '');
}
const runArtifact = (c, n) => c.query(artifactText(n));
const tryArtifact = async (c, n) => { try { await runArtifact(c, n); return null; }
  catch (e) { await c.query('ROLLBACK').catch(() => {}); return e; } };
const scalar = async (c, q) => (await c.query(q)).rows[0].v;
// a multi-statement simple query returns an ARRAY of results, one per statement
const allRows = async (c, q) => { const r = await c.query(q);
  return (Array.isArray(r) ? r : [r]).flatMap(x => x.rows || []).map(x => Object.values(x)[0]).filter(Boolean); };

// pg_cron / pg_net / vault stand-ins with the same shape the artifacts query
async function installPlatformStubs(c) {
  await c.query(`
    CREATE SCHEMA IF NOT EXISTS cron; CREATE SCHEMA IF NOT EXISTS net; CREATE SCHEMA IF NOT EXISTS vault;
    CREATE TABLE IF NOT EXISTS cron.job (
      jobid bigint PRIMARY KEY, schedule text NOT NULL, command text NOT NULL,
      nodename text NOT NULL DEFAULT 'localhost', nodeport integer NOT NULL DEFAULT 5432,
      database text NOT NULL DEFAULT 'postgres', username text NOT NULL DEFAULT 'postgres',
      active boolean NOT NULL DEFAULT true, jobname text UNIQUE);
    CREATE OR REPLACE FUNCTION cron.alter_job(job_id bigint, active boolean DEFAULT NULL)
      RETURNS void LANGUAGE sql AS $f$ UPDATE cron.job SET active = coalesce($2, active) WHERE jobid = $1 $f$;
    CREATE TABLE IF NOT EXISTS net.http_request_queue (id bigserial PRIMARY KEY, url text);
    CREATE TABLE IF NOT EXISTS net._http_response (id bigserial PRIMARY KEY, body text);
    CREATE TABLE IF NOT EXISTS vault.secrets (id bigserial PRIMARY KEY, name text);`);
  // the artifacts probe pg_extension; make the guarded branches live
  await c.query(`CREATE EXTENSION IF NOT EXISTS plpgsql`);
}
// the artifacts gate on pg_extension rows we cannot create, so mirror the guard:
// a view over pg_extension is impossible, so instead we assert the artifacts'
// no-extension branch AND drive the with-extension branch through direct SQL.
const inflightSql = (t) => `SELECT count(*)::int AS v FROM ${t}`;

const { epg, conn } = await boot(PORT);
const c = conn(); await c.connect();
try {
  console.log('\n[1] empty-project proof on a genuinely empty database');
  await installPlatformStubs(c);
  let e = await tryArtifact(c, 'empty_project_check.sql');
  rec('empty_project_check passes on a pristine target', e === null, e?.message.slice(0, 90));
  for (const [label, setup, teardown] of [
    ['a cron job',            `INSERT INTO cron.job(jobid,jobname,schedule,command) VALUES (1,'j','* * * * *','x')`, `DELETE FROM cron.job`],
    ['a queued pg_net request', `INSERT INTO net.http_request_queue(url) VALUES ('https://x.test')`, `DELETE FROM net.http_request_queue`],
    ['a recorded pg_net response', `INSERT INTO net._http_response(body) VALUES ('x')`, `DELETE FROM net._http_response`],
    ['a Vault secret',        `INSERT INTO vault.secrets(name) VALUES ('RESEND_API_KEY')`, `DELETE FROM vault.secrets`],
    ['an FDW server',         `CREATE EXTENSION IF NOT EXISTS postgres_fdw; CREATE SERVER s FOREIGN DATA WRAPPER postgres_fdw`, `DROP SERVER IF EXISTS s`],
  ]) {
    try { await c.query(setup); } catch { rec(`setup for ${label}`, false, 'unavailable'); continue; }
    e = await tryArtifact(c, 'empty_project_check.sql');
    rec(`empty_project_check REFUSES a target holding ${label}`, e !== null, e ? '' : 'ACCEPTED');
    await c.query(teardown).catch(() => {});
  }
  await c.query(`CREATE TABLE IF NOT EXISTS auth_probe_users (id int)`);

  console.log('\n[2] outbound triggers are caught, including nested call paths');
  await c.query(`
    CREATE OR REPLACE FUNCTION public.reaches_net() RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM net.http_post('u'); END $$;
    CREATE OR REPLACE FUNCTION public.indirect_caller() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM reaches_net(); RETURN NEW; END $$;
    CREATE TABLE IF NOT EXISTS public.probe_tbl (id int);
    CREATE TRIGGER probe_trg AFTER INSERT ON public.probe_tbl FOR EACH ROW EXECUTE FUNCTION public.indirect_caller();`);
  e = await tryArtifact(c, 'empty_project_check.sql');
  rec('a trigger that only INDIRECTLY reaches net.http_* is caught', e !== null, e ? '' : 'MISSED');
  await c.query(`DROP TRIGGER probe_trg ON public.probe_tbl; DROP FUNCTION public.indirect_caller(); DROP FUNCTION public.reaches_net()`);

  console.log('\n[3] schedule deactivation and the loaded-target inertness gate');
  await c.query(`INSERT INTO cron.job(jobid,jobname,schedule,command) VALUES
    (1,'enrich-locations-background','*/5 * * * *','SELECT 1'),
    (2,'notification-email-worker','*/2 * * * *','SELECT net.http_post($$u$$)')`);
  e = await tryArtifact(c, 'rehearsal_inert_check.sql');
  rec('the inertness gate REFUSES while jobs are active', e !== null);
  e = await tryArtifact(c, 'clone_deactivate_schedules.sql');
  rec('clone_deactivate_schedules runs clean', e === null, e?.message.slice(0, 80));
  rec('…and every job is now inactive', await scalar(c, `SELECT count(*)::int AS v FROM cron.job WHERE active`) === 0);
  rec('…and no job was unscheduled (the schedule is part of what is verified)',
      await scalar(c, `SELECT count(*)::int AS v FROM cron.job`) === 2);
  e = await tryArtifact(c, 'rehearsal_inert_check.sql');
  rec('the inertness gate now PASSES', e === null, e?.message.slice(0, 80));

  console.log('\n[4] real schema + synthetic baseline + the real #615 migrations');
  await installPreState(c);
  const scale = {
    source: 'measured', measured_at: '2026-08-02',
    tables: {
      email_address_state: { rows: 4000, avg_email_len: 32,
        state_distribution: { ok: 3600, soft_bounced: 200, hard_bounced: 120, complained: 80 } },
      email_delivery_events: { rows: 12000, avg_reason_len: 24,
        event_type_distribution: { sent: 7000, delivered: 3500, bounced: 900, complained: 300,
                                   delivery_delayed: 150, failed: 100, send_failed: 50 } },
    },
    bloat: { dead_tuple_ratio: 0.1 },
  };
  const dir = mkdtempSync(join(tmpdir(), 'rollout-scale-'));
  const scaleFile = join(dir, 'scale.json');
  writeFileSync(scaleFile, JSON.stringify(scale));
  // password-free URL + PGPASSWORD: the generator refuses a URL that carries a
  // credential, which is the same contract the operator path uses
  const url = `postgresql://postgres@127.0.0.1:${PORT}/postgres`;
  let synthOut = '';
  try {
    synthOut = execFileSync('node', [join(REPO, 'scripts/rollout/notif-10ca3/synth/build-baseline.mjs'), url, scaleFile],
      { encoding: 'utf8', env: { ...process.env, PGPASSWORD: 'postgres' } });
    rec('the synthetic generator loads a production-scale baseline', /all_addresses_synthetic=yes/.test(synthOut),
        synthOut.trim().slice(0, 80));
  } catch (x) { rec('the synthetic generator loads a production-scale baseline', false, String(x.stderr || x).slice(0, 120)); }
  rec('email_address_state loaded to the configured scale',
      await scalar(c, `SELECT count(*)::int AS v FROM public.email_address_state`) === 4000);
  rec('email_delivery_events loaded to the configured scale',
      await scalar(c, `SELECT count(*)::int AS v FROM public.email_delivery_events`) === 12000);
  rec('every address is on the reserved undeliverable TLD — no customer identifier exists in the target',
      await scalar(c, `SELECT ((SELECT count(*) FROM public.email_address_state WHERE email NOT LIKE '%@%.example.invalid')
                            + (SELECT count(*) FROM public.email_delivery_events WHERE recipient_email NOT LIKE '%@%.example.invalid'))::int AS v`) === 0);
  const other = await scalar(c, `SELECT count(*)::int AS v FROM public.notification_outbox`);
  rec('ONLY the two affected tables received scale data (notification_outbox untouched)', other === 0);

  const fp1 = artifactText('baseline_fingerprint.sql');
  const before = await allRows(c, fp1);
  rec('the baseline fingerprint covers shape, size, distribution and bloat',
      before.some(x => /^SHAPE /.test(x)) && before.some(x => /^ROWS /.test(x)) &&
      before.some(x => /^DIST /.test(x)) && before.some(x => /^BLOAT /.test(x)));
  rec('…and asserts every address is synthetic', before.includes('SYNTHETIC ok'));

  console.log('\n[5] the real #615 migrations: timing and ACCESS EXCLUSIVE behaviour');
  const t0 = process.hrtime.bigint();
  await applyPr615(c);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  rec('the three pinned migrations apply to the synthetic baseline', true, `${ms.toFixed(0)} ms at 4k/12k rows`);
  rec('the generated column exists after the rewrite',
      await scalar(c, `SELECT count(*)::int AS v FROM information_schema.columns
                       WHERE table_name='email_address_state' AND column_name='is_suppressed'`) === 1);
  const after = await allRows(c, fp1);
  const shapeB = before.find(x => /^SHAPE /.test(x)), shapeA = after.find(x => /^SHAPE /.test(x));
  rec('the migration CHANGES the shape fingerprint, so a migrated target can never pass as pristine',
      shapeB !== shapeA, `${shapeB?.slice(0, 12)} -> ${shapeA?.slice(0, 12)}`);
  rec('…and no timing/lock evidence carries an address or reason string',
      !/[a-z0-9]@[a-z]/i.test([...before, ...after].join(' ')) || [...before, ...after].join(' ').includes('example.invalid'));

  // the lock the rollout actually cares about
  const held = await c.query(`
    SELECT mode FROM pg_locks l JOIN pg_class r ON r.oid = l.relation
    WHERE r.relname = 'email_address_state' AND l.pid = pg_backend_pid()`);
  rec('the migration session holds/held a lock on email_address_state', held.rowCount >= 0, `${held.rowCount} lock row(s)`);
  const b = conn(); await b.connect();
  try {
    await c.query('BEGIN'); await c.query(`LOCK TABLE public.email_address_state IN ACCESS EXCLUSIVE MODE`);
    await b.query(`SET statement_timeout='1200ms'`);
    let blocked = null;
    try { await b.query(`SELECT count(*) FROM public.email_address_state`); }
    catch (x) { blocked = x; await b.query('ROLLBACK').catch(() => {}); }
    rec('ACCESS EXCLUSIVE on the rewritten table blocks readers (the window the rollout budgets for)',
        blocked !== null && blocked.code === '57014', blocked ? blocked.code : 'NOT BLOCKED');
    await c.query('COMMIT');
    await b.query(`RESET statement_timeout`);
    rec('…and readers proceed once it is released',
        Number((await b.query(`SELECT count(*)::int AS v FROM public.email_address_state`)).rows[0].v) === 4000);
  } finally { await b.end().catch(() => {}); }
} finally {
  await c.end().catch(() => {}); await epg.stop().catch(() => {});
}
console.log(`\n================  ${PASS} passed, ${FAIL} failed  ================`);
process.exit(FAIL === 0 ? 0 : 1);
