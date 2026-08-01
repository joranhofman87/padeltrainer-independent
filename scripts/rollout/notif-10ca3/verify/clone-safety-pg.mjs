// ===========================================================================
// clone-safety-pg.mjs — EXECUTE the clone-safety SQL on a REAL PostgreSQL.
//
// The bash suite interprets the artifacts' text; this one runs them. Everything
// that matters here is genuine Postgres behaviour: the statement-level trigger
// really fires, the transaction really rolls back, the FULL OUTER JOIN really
// computes, has_*_privilege really reflects the grants, and a second connection
// really observes only committed states.
//
// pg_cron itself is not installable in the embedded server, so cron.job,
// cron.job_run_details, cron.alter_job and net.http_request_queue are created as
// REAL tables and a REAL function with pg_cron's shape. That is the only stand-in:
// every object the artifacts touch behaves exactly as it would in production,
// and the artifacts are read from disk unmodified apart from inlining \ir
// includes and substituting :'vars' the way psql would.
//
// Run: node scripts/rollout/notif-10ca3/verify/clone-safety-pg.mjs
// ===========================================================================
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot, SQL_DIR } from './chain.mjs';

const PORT = 54371;
let PASS = 0, FAIL = 0;
const rec = (name, ok, detail = '') => {
  const l = `  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`;
  (ok ? console.log : console.error)(l); ok ? PASS++ : FAIL++;
};

// ---- psql-faithful artifact loading ---------------------------------------
function artifactText(name, vars = {}) {
  let t = readFileSync(join(SQL_DIR, name), 'utf8');
  for (let i = 0; i < 6; i++) {
    const before = t;
    t = t.replace(/^\\ir? ([A-Za-z0-9_.]+\.sql)\s*$/gm, (_m, f) => readFileSync(join(SQL_DIR, f), 'utf8'));
    if (t === before) break;
  }
  t = t.replace(/^\\.*$/gm, '');
  for (const [k, v] of Object.entries(vars)) {
    t = t.split(`:'${k}'`).join(`'${String(v).replace(/'/g, "''")}'`);
  }
  return t;
}
// The artifact's OWN BEGIN/COMMIT must provide the atomicity, so the pg_temp
// helper definitions that precede it are sent as a separate statement first;
// otherwise node-pg's implicit transaction would supply it for us and the test
// would prove nothing about the artifact.
async function runArtifact(c, name, vars = {}) {
  const t = artifactText(name, vars);
  const i = t.search(/^BEGIN;$/m);
  if (i < 0) { await c.query(t); return; }
  await c.query(t.slice(0, i));
  await c.query(t.slice(i));
}
// A failed statement inside an explicit BEGIN leaves the session in an aborted
// transaction block (the artifact's own COMMIT is never reached — which is the
// atomicity we are testing), so the caller must roll it back before continuing.
const tryArtifact = async (c, name, vars) => {
  try { await runArtifact(c, name, vars); return null; }
  catch (e) { await c.query('ROLLBACK').catch(() => {}); return e; }
};
const scalar = async (c, q) => (await c.query(q)).rows[0].v;

// ---- pg_cron-shaped stand-in ----------------------------------------------
const JOBS = [
  [1,  'release-expired-rebook-holds',  '*/5 * * * *',  'SELECT public.release_expired()',  true],
  [9,  'notification-email-worker',     '*/2 * * * *',  'SELECT net.http_post($$a$$)',      true],
  [10, 'notification-whatsapp-worker',  '*/2 * * * *',  'SELECT net.http_post($$b$$)',      false],
];
async function installCron(c) {
  await c.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
    END $$;
    DROP SCHEMA IF EXISTS rollout_clone CASCADE;
    DROP SCHEMA IF EXISTS cron CASCADE; DROP SCHEMA IF EXISTS net CASCADE;
    CREATE SCHEMA cron; CREATE SCHEMA net;
    CREATE TABLE cron.job (
      jobid bigint PRIMARY KEY, schedule text NOT NULL, command text NOT NULL,
      nodename text NOT NULL DEFAULT 'localhost', nodeport integer NOT NULL DEFAULT 5432,
      database text NOT NULL DEFAULT 'postgres', username text NOT NULL DEFAULT 'postgres',
      active boolean NOT NULL DEFAULT true, jobname text UNIQUE);
    CREATE TABLE cron.job_run_details (
      runid bigserial PRIMARY KEY, jobid bigint, status text, start_time timestamptz DEFAULT now());
    CREATE FUNCTION cron.alter_job(job_id bigint, schedule text DEFAULT NULL, command text DEFAULT NULL,
                                   database text DEFAULT NULL, username text DEFAULT NULL, active boolean DEFAULT NULL)
      RETURNS void LANGUAGE plpgsql AS $f$
      BEGIN
        UPDATE cron.job j SET
          schedule = coalesce(alter_job.schedule, j.schedule),
          command  = coalesce(alter_job.command,  j.command),
          database = coalesce(alter_job.database, j.database),
          username = coalesce(alter_job.username, j.username),
          active   = coalesce(alter_job.active,   j.active)
        WHERE j.jobid = job_id;
      END $f$;
    CREATE TABLE net.http_request_queue (id bigserial PRIMARY KEY, url text);
    -- pg_net's own enqueue path: http_post INSERTs into the queue and returns the id
    CREATE FUNCTION net.http_post(url text) RETURNS bigint LANGUAGE plpgsql AS $h$
      DECLARE i bigint;
      BEGIN INSERT INTO net.http_request_queue (url) VALUES (url) RETURNING id INTO i; RETURN i; END $h$;
    -- pg_cron registers cron.log_run; a placeholder GUC gives pg_settings the
    -- same visible shape, so both the on and off branches are exercised for real.
    SET cron.log_run = 'on';`);
  for (const [id, name, sched, cmd, active] of JOBS) {
    await c.query(`INSERT INTO cron.job (jobid, jobname, schedule, command, active) VALUES ($1,$2,$3,$4,$5)`,
      [id, name, sched, cmd, active]);
  }
}
const NONCE = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const cfgFp = (c) => scalar(c, `SELECT md5(string_agg(jobid::text||chr(31)||jobname||chr(31)||schedule||chr(31)||database||chr(31)||username||chr(31)||md5(command)||chr(31)||coalesce(nodename,'')||chr(31)||nodeport::text, E'\\n' ORDER BY jobid)) AS v FROM cron.job`);
const activeCount = (c) => scalar(c, `SELECT count(*)::int AS v FROM cron.job WHERE active`);
const fenceCount  = (c) => scalar(c, `SELECT count(*)::int AS v FROM pg_trigger WHERE tgrelid IN ('cron.job'::regclass,'net.http_request_queue'::regclass) AND NOT tgisinternal AND tgname LIKE 'rollout\\_clone\\_fence%'`);
const queueLen    = (c) => scalar(c, `SELECT count(*)::int AS v FROM net.http_request_queue`);
const markerCount = (c) => scalar(c, `SELECT count(*)::int AS v FROM information_schema.tables WHERE table_schema='rollout_clone' AND table_name='snapshot_marker'`);
async function seal(c) { await installCron(c); return tryArtifact(c, 'clone_source_seal.sql', { nonce: NONCE, expect_fp: await cfgFp(c) }); }

// ---------------------------------------------------------------------------
const { epg, conn } = await boot(PORT);
const c = conn(); await c.connect();
const b = conn(); await b.connect();          // a second, independent session
try {
  console.log('\n[1] the fence really blocks every write path to cron.job');
  let err = await seal(c);
  rec('the seal artifact runs clean on a real Postgres', err === null, err?.message);
  rec('three fence triggers exist (two on cron.job, one on the pg_net queue)', await fenceCount(c) === 3);
  for (const [label, stmt] of [
    ['direct INSERT (what cron.schedule does)', `INSERT INTO cron.job (jobid,jobname,schedule,command) VALUES (77,'sneak','* * * * *','SELECT 1')`],
    ['direct UPDATE',                           `UPDATE cron.job SET active = true WHERE jobid = 9`],
    ['direct DELETE (what cron.unschedule does)',`DELETE FROM cron.job WHERE jobid = 9`],
    ['TRUNCATE',                                `TRUNCATE cron.job`],
    ['cron.alter_job (SECURITY DEFINER path)',  `SELECT cron.alter_job(9, active := true)`],
    ['a zero-row UPDATE',                       `UPDATE cron.job SET active = active WHERE false`],
    ['a direct pg_net queue INSERT',            `INSERT INTO net.http_request_queue (url) VALUES ('https://sneak.test')`],
    ['net.http_post() (the pg_net enqueue path)',`SELECT net.http_post('https://sneak.test')`],
  ]) {
    let e = null; try { await c.query(stmt); } catch (x) { e = x; }
    rec(`fence rejects ${label}`, e !== null && /clone-safety fence/.test(e.message) && e.code === '42501',
        e ? `${e.code}` : 'NOT REJECTED');
  }
  rec('no cron row was created by any blocked attempt', await scalar(c, `SELECT count(*)::int AS v FROM cron.job`) === 3);
  rec('no outbound request was queued by any blocked attempt', await queueLen(c) === 0);

  console.log('\n[2] the seal is atomic: a failure leaves nothing behind');
  await installCron(c);
  await c.query(`INSERT INTO net.http_request_queue (url) VALUES ('https://example.test')`);
  err = await tryArtifact(c, 'clone_source_seal.sql', { nonce: NONCE, expect_fp: await cfgFp(c) });
  rec('seal REFUSES with a non-empty pg_net queue', err !== null, err?.message.slice(0, 60));
  rec('…no rollout_clone schema was left behind', await markerCount(c) === 0);
  rec('…no fence trigger was left behind on either table', await fenceCount(c) === 0);
  rec('…every job is still ACTIVE (nothing was paused)', await activeCount(c) === 2);
  await installCron(c);
  err = await tryArtifact(c, 'clone_source_seal.sql', { nonce: NONCE, expect_fp: 'deadbeefdeadbeefdeadbeefdeadbeef' });
  rec('seal REFUSES when the live configuration is not the reviewed one', err !== null);
  rec('…and again left nothing behind', await activeCount(c) === 2 && await fenceCount(c) === 0);

  console.log('\n[3] in-flight runs: every NON-TERMINAL pg_cron state blocks arming');
  for (const st of ['starting', 'connecting', 'sending', 'running', null, 'a-future-state-nobody-anticipated']) {
    await seal(c);
    await c.query(`INSERT INTO cron.job_run_details (jobid, status) VALUES (9, $1)`, [st]);
    err = await tryArtifact(c, 'clone_source_arm.sql', { nonce: NONCE });
    rec(`arm REFUSES with a run in status ${st === null ? 'NULL' : `'${st}'`}`, err !== null,
        err ? '' : 'ARMED ANYWAY');
  }
  for (const st of ['succeeded', 'failed']) {
    await seal(c);
    await c.query(`INSERT INTO cron.job_run_details (jobid, status) VALUES (9, $1)`, [st]);
    err = await tryArtifact(c, 'clone_source_arm.sql', { nonce: NONCE });
    rec(`arm proceeds with only terminal '${st}' runs`, err === null, err?.message.slice(0, 60));
  }
  // A request cannot legitimately appear between seal and arm any more — the
  // queue fence prevents it. Disable the trigger to simulate a bypass and prove
  // the arm's own queue assertion is still load-bearing behind the fence.
  await seal(c);
  await c.query(`ALTER TABLE net.http_request_queue DISABLE TRIGGER rollout_clone_fence_netq`);
  await c.query(`INSERT INTO net.http_request_queue (url) VALUES ('https://late.test')`);
  await c.query(`ALTER TABLE net.http_request_queue ENABLE TRIGGER rollout_clone_fence_netq`);
  err = await tryArtifact(c, 'clone_source_arm.sql', { nonce: NONCE });
  rec('arm REFUSES with a queued pg_net request (defence behind the fence)', err !== null);

  console.log('\n[4] cron.log_run must be on, or quiescence is unprovable');
  await seal(c);
  await c.query(`SET cron.log_run = 'off'`);
  err = await tryArtifact(c, 'clone_source_arm.sql', { nonce: NONCE });
  rec('arm REFUSES when cron.log_run is off (a zero count would be a false green)', err !== null,
      err?.message.slice(0, 80));
  await c.query(`SET cron.log_run = 'on'`);
  err = await tryArtifact(c, 'clone_source_arm.sql', { nonce: NONCE });
  rec('…and proceeds once it is on', err === null, err?.message.slice(0, 60));

  console.log('\n[5] the ACL matrix is enforced source-side, before the commit');
  await seal(c);
  for (const r of ['anon', 'authenticated', 'service_role']) {
    const u = await scalar(c, `SELECT has_schema_privilege('${r}','rollout_clone','USAGE') AS v`);
    const f = await scalar(c, `SELECT has_function_privilege('${r}','rollout_clone.fence_cron_job()','EXECUTE') AS v`);
    const t = await scalar(c, `SELECT has_table_privilege('${r}','rollout_clone.snapshot_marker','SELECT') AS v`);
    rec(`${r} has no USAGE, no EXECUTE on the fence function and no table access`, !u && !f && !t);
  }
  rec('PUBLIC cannot EXECUTE the fence function',
      await scalar(c, `SELECT has_function_privilege('public','rollout_clone.fence_cron_job()','EXECUTE') AS v`) === false);
  await c.query(`GRANT USAGE ON SCHEMA rollout_clone TO anon`);
  err = await tryArtifact(c, 'clone_source_arm.sql', { nonce: NONCE });
  rec('a leaked grant is caught by the SAME matrix at the next checkpoint', err !== null, err?.message.slice(0, 60));

  console.log('\n[6] resume: exact restoration, and atomic on failure');
  await seal(c);
  await runArtifact(c, 'clone_source_arm.sql', { nonce: NONCE });
  await c.query(`ALTER TABLE cron.job DISABLE TRIGGER rollout_clone_fence_dml`);  // simulate drift the fence cannot see
  await c.query(`UPDATE cron.job SET command = 'SELECT net.http_post($$CHANGED$$)' WHERE jobid = 9`);
  await c.query(`ALTER TABLE cron.job ENABLE TRIGGER rollout_clone_fence_dml`);
  err = await tryArtifact(c, 'clone_source_resume.sql', { nonce: NONCE, allow_unarmed: '0' });
  rec('resume REFUSES when a command changed under the same id and name', err !== null, err?.message.slice(0, 70));
  rec('…and rolled back completely: all three fences still installed', await fenceCount(c) === 3);
  rec('…marker still present', await markerCount(c) === 1);
  rec('…every job still inactive', await activeCount(c) === 0);

  await seal(c);
  await runArtifact(c, 'clone_source_arm.sql', { nonce: NONCE });
  rec('inside the window: marker present AND zero active jobs',
      await markerCount(c) === 1 && await activeCount(c) === 0);
  await runArtifact(c, 'clone_source_resume.sql', { nonce: NONCE, allow_unarmed: '0' });
  rec('after resume: marker gone', await markerCount(c) === 0);
  rec('after resume: fence gone', await fenceCount(c) === 0);
  rec('after resume: EXACT prior active states restored (1 and 9 active, 10 inactive)',
      await scalar(c, `SELECT string_agg(jobid||':'||active, ',' ORDER BY jobid) AS v FROM cron.job`) === '1:true,9:true,10:false');

  console.log('\n[7] a SECOND session never observes a marker beside active cron');
  await seal(c);
  await runArtifact(c, 'clone_source_arm.sql', { nonce: NONCE });
  const t = artifactText('clone_source_resume.sql', { nonce: NONCE, allow_unarmed: '0' });
  const i = t.search(/^BEGIN;$/m);
  await c.query(t.slice(0, i));
  await c.query(t.slice(i).replace(/^COMMIT;$/m, ''));      // everything except the COMMIT
  // cron.job is held in ACCESS EXCLUSIVE for the whole transition, so another
  // session cannot even READ an intermediate state — it blocks until the commit.
  await b.query(`SET statement_timeout = '1500ms'`);
  let blocked = null;
  try { await b.query(`SELECT count(*) FROM cron.job WHERE active`); }
  catch (e) { blocked = e; await b.query('ROLLBACK').catch(() => {}); }
  rec('mid-transaction, another session cannot read cron.job at all (it blocks on the lock)',
      blocked !== null && blocked.code === '57014', blocked ? blocked.code : 'READ SUCCEEDED');
  await b.query(`RESET statement_timeout`);
  const midMarker = await markerCount(b);
  rec('…and still sees the PRE state: the marker is present', midMarker === 1, `marker=${midMarker}`);
  await c.query('COMMIT');
  const postMarker = await markerCount(b), postActive = await activeCount(b);
  rec('after the commit it sees the POST state (marker gone, prior actives restored)',
      postMarker === 0 && postActive === 2, `marker=${postMarker} active=${postActive}`);
  rec('so no committed state carries a valid marker beside active cron',
      midMarker === 1 && !(postMarker === 1 && postActive > 0));

  console.log('\n[7b] pg_net is FROZEN across the armed window, from another session');
  await seal(c);
  await runArtifact(c, 'clone_source_arm.sql', { nonce: NONCE });
  // a second, fully independent connection — a background worker, an edge
  // function, an admin session: anything that could enqueue after the arm
  for (const [label, stmt] of [
    ['a direct INSERT',   `INSERT INTO net.http_request_queue (url) VALUES ('https://after-arm.test')`],
    ['net.http_post()',   `SELECT net.http_post('https://after-arm.test')`],
  ]) {
    let e = null; try { await b.query(stmt); } catch (x) { e = x; await b.query('ROLLBACK').catch(() => {}); }
    rec(`another session cannot enqueue via ${label} after the arm`,
        e !== null && /clone-safety fence/.test(e.message) && e.code === '42501', e ? e.code : 'ENQUEUED');
  }
  rec('the queue is still empty, so nothing can cross into a clone', await queueLen(b) === 0);
  let ce = await tryArtifact(c, 'clone_isolation.sql', { nonce: NONCE });
  rec('the clone gate re-proves the queue fence inside the clone', ce === null, ce?.message.slice(0, 70));
  await runArtifact(c, 'clone_source_resume.sql', { nonce: NONCE, allow_unarmed: '0' });
  rec('resume drops the queue fence atomically with everything else', await fenceCount(c) === 0);
  const after = await b.query(`SELECT net.http_post('https://after-resume.test') AS v`);
  rec('…and pg_net can enqueue again once the window is closed', Number(after.rows[0].v) > 0);

  console.log('\n[8] lifecycle: no implicit reuse, and real run-level exclusion');
  await seal(c);
  err = await tryArtifact(c, 'clone_source_seal.sql', { nonce: 'ffffffffffffffffffffffffffffffff', expect_fp: await cfgFp(c) });
  rec('a second seal is REFUSED while a window is open', err !== null, err?.message.slice(0, 60));
  rec('…and the original marker is untouched',
      await scalar(c, `SELECT nonce AS v FROM rollout_clone.snapshot_marker`) === NONCE);
  await runArtifact(c, 'clone_source_resume.sql', { nonce: NONCE, allow_unarmed: '1' });
  await installCron(c);
  await b.query(`SELECT pg_advisory_lock(431097, 626)`);     // another operator, mid-run
  err = await tryArtifact(c, 'clone_source_seal.sql', { nonce: NONCE, expect_fp: await cfgFp(c) });
  rec('a concurrent run holding the advisory lock blocks a second seal', err !== null, err?.message.slice(0, 60));
  await b.query(`SELECT pg_advisory_unlock(431097, 626)`);

  console.log('\n[9] the clone gate, executed against a real restored state');
  await seal(c);
  await runArtifact(c, 'clone_source_arm.sql', { nonce: NONCE });
  err = await tryArtifact(c, 'clone_isolation.sql', { nonce: NONCE });
  rec('a state inside the armed, fenced window passes the clone gate', err === null, err?.message.slice(0, 80));
  err = await tryArtifact(c, 'clone_isolation.sql', { nonce: 'ffffffffffffffffffffffffffffffff' });
  rec('a different run\'s nonce is refused', err !== null);
  await c.query(`INSERT INTO cron.job_run_details (jobid, status) VALUES (9, 'sending')`);
  err = await tryArtifact(c, 'clone_isolation.sql', { nonce: NONCE });
  rec("a clone with a run in 'sending' is refused (not just 'running')", err !== null);
  await c.query(`DELETE FROM cron.job_run_details`);
  await c.query(`DROP TRIGGER rollout_clone_fence_netq ON net.http_request_queue`);
  err = await tryArtifact(c, 'clone_isolation.sql', { nonce: NONCE });
  rec('a clone missing ONLY the pg_net queue fence is refused', err !== null);
  await c.query(`DROP TRIGGER rollout_clone_fence_dml ON cron.job; DROP TRIGGER rollout_clone_fence_truncate ON cron.job`);
  err = await tryArtifact(c, 'clone_isolation.sql', { nonce: NONCE });
  rec('a clone whose fences are gone is refused (restore point outside the window)', err !== null);
} finally {
  await c.end().catch(() => {}); await b.end().catch(() => {});
  await epg.stop().catch(() => {});
}
console.log(`\n================  ${PASS} passed, ${FAIL} failed  ================`);
process.exit(FAIL === 0 ? 0 : 1);
