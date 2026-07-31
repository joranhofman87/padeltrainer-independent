// ===========================================================================
// rehearsals.mjs — EXECUTABLE, evidence-producing A/B/C/D rehearsals on a real
// (embedded) Postgres, each on its own fresh database. These execute the
// behaviours the owner's prod-snapshot db-push rehearsals depend on:
//   A  measure the ACCESS EXCLUSIVE rewrite window (A_window) + derive CAP
//   B  bounded lock_timeout aborts under contention -> delta ABSENT (no partial)
//   C  the real per-file ledger model: none -> PREFIX -> all, and recovery
//      (re-push) resumes from the failed file
//   D  full apply + baseline-preserve + academy_fixture + postflight + acl + ledger
// The real `supabase db push` against prod-scale snapshots stays owner-only;
// these prove the SQL/atomicity/lock/recovery behaviour deterministically.
//
// Run:  node scripts/rollout/notif-10ca3/verify/rehearsals.mjs
// ===========================================================================
import pg from 'pg';
import { boot, installPreState, applyPr615, migPR615, prepared, preparedPlain, PR615_MIGS, PR615_SHA } from './chain.mjs';

const PORT = 54358;
const VERSIONS = PR615_MIGS.map((f) => f.slice(0, 14));
let PASS = 0, FAIL = 0;
const lines = [];
function record(name, ok, detail = '') {
  const l = `  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`;
  lines.push(l); (ok ? console.log : console.error)(l);
  ok ? PASS++ : FAIL++;
}
function note(m) { lines.push(`        · ${m}`); console.log(`        · ${m}`); }

const { Client } = pg;
let BASE_URL = '';
const connTo = (db) => new Client({ connectionString: BASE_URL.replace(/\/postgres$/, `/${db}`) });

async function freshDb(admin, name) {
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  const c = connTo(name); await c.connect();
  await installPreState(c);
  return c;
}

// ---- A: measure A_window + CAP -------------------------------------------
async function rehearsalA(admin) {
  console.log('\n[A] measure A_window (ACCESS EXCLUSIVE rewrite) + CAP:');
  const c = await freshDb(admin, 'rehearse_a');
  try {
    const N = 20000;
    await c.query(`INSERT INTO public.email_address_state(email,state)
      SELECT 'u'||g||'@ex.test','ok' FROM generate_series(1,${N}) g`);
    const t0 = process.hrtime.bigint();
    await c.query(migPR615(PR615_MIGS[0]));           // includes ADD COLUMN is_suppressed ... STORED (rewrite)
    const t1 = process.hrtime.bigint();
    const ms = Number(t1 - t0) / 1e6;
    const capStmt = Math.round(30000 + ms * 1.5);      // measured + 50% headroom
    note(`A_window: rewrite of ${N} rows via migration 20261006100000 took ${ms.toFixed(1)} ms`);
    note(`derived CAP_STMT (measured + 50% headroom) = ${capStmt} ms; CAP_LOCK = 3000 ms`);
    const present = (await c.query(`SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='email_address_state' AND column_name='is_suppressed'`)).rowCount === 1;
    record('A: rewrite applied + measured, is_suppressed present', present, `${ms.toFixed(0)}ms for ${N} rows`);
  } finally { await c.end(); }
}

// ---- B: bounded lock_timeout aborts under contention -> delta ABSENT ------
async function rehearsalB(admin) {
  console.log('\n[B] lock_timeout abort under contention -> no partial delta:');
  const c = await freshDb(admin, 'rehearse_b');
  const holder = connTo('rehearse_b'); await holder.connect();
  try {
    await c.query(`INSERT INTO public.email_address_state(email,state) VALUES ('a@ex.test','ok')`);
    await holder.query('BEGIN');
    await holder.query('LOCK TABLE public.email_address_state IN ACCESS EXCLUSIVE MODE');
    await c.query(`SET lock_timeout='500ms'`);
    let code = '', failed = false;
    try { await c.query(migPR615(PR615_MIGS[0])); }
    catch (e) { failed = true; code = e.code; }
    record('B: bounded db push aborts on lock contention', failed && code === '55P03', `sqlstate=${code || 'none'} (55P03=lock_not_available)`);
    await c.query('ROLLBACK').catch(() => {});          // clear the aborted tx on c
    const absent = (await c.query(`SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='email_address_state' AND column_name='is_suppressed'`)).rowCount === 0;
    record('B: after abort, is_suppressed column is ABSENT (atomic per-file)', absent);
  } finally { await holder.query('ROLLBACK').catch(() => {}); await holder.end(); await c.end(); }
}

// ---- C: none -> PREFIX -> all ledger model + recovery ---------------------
function ledgerStatus(applied) {
  const set = new Set(applied);
  const have = VERSIONS.filter((v) => set.has(v));
  if (have.length === 0) return 'none';
  if (have.length === VERSIONS.length) return 'all';
  return 'prefix';
}
async function appliedVersions(c) {
  const r = await c.query(`SELECT version FROM supabase_migrations.schema_migrations
                           WHERE version = ANY($1) ORDER BY version`, [VERSIONS]);
  return r.rows.map((x) => x.version);
}
async function rehearsalC(admin) {
  console.log('\n[C] ledger model none -> PREFIX -> all + recovery:');
  const c = await freshDb(admin, 'rehearse_c');
  try {
    // the CLI's ledger (version text PK, statements text[], name text)
    await c.query(`CREATE SCHEMA IF NOT EXISTS supabase_migrations;
      CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, statements text[], name text)`);
    record('C: none state detected', ledgerStatus(await appliedVersions(c)) === 'none');

    // apply file 1 as its own committed txn + ledger insert (mirrors ExecBatch)
    await c.query('BEGIN');
    await c.query(migPR615(PR615_MIGS[0]));
    await c.query(`INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES ($1,$2)`, [VERSIONS[0], PR615_MIGS[0]]);
    await c.query('COMMIT');

    // file 2's txn FAILS after its statements (simulated crash) -> whole file rolls back, ledger unchanged
    await c.query('BEGIN');
    await c.query(migPR615(PR615_MIGS[1]));
    await c.query(`INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES ($1,$2)`, [VERSIONS[1], PR615_MIGS[1]]);
    try { await c.query(`DO $$ BEGIN RAISE EXCEPTION 'simulated mid-push failure on file 2'; END $$`); } catch { /* expected */ }
    await c.query('ROLLBACK').catch(() => {});          // whole file-2 txn discarded; ledger stays at {file1}

    const afterFail = await appliedVersions(c);
    record('C: PREFIX state after mid-push failure', ledgerStatus(afterFail) === 'prefix', `applied=[${afterFail.join(',')}]`);
    const mig1Present = (await c.query(`SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='email_address_state' AND column_name='is_suppressed'`)).rowCount === 1;
    const mig2Absent = (await c.query(`SELECT to_regclass('public.notification_orphan_reconcile_state') IS NULL x`)).rows[0].x;
    record('C: prefix is consistent (file1 applied, file2 absent)', mig1Present && mig2Absent);

    // recovery = re-run push: apply only the pending (2 and 3), each with ledger insert
    const applied = new Set(afterFail);
    for (let i = 0; i < PR615_MIGS.length; i++) {
      if (applied.has(VERSIONS[i])) continue;
      await c.query('BEGIN');
      await c.query(migPR615(PR615_MIGS[i]));
      await c.query(`INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES ($1,$2)`, [VERSIONS[i], PR615_MIGS[i]]);
      await c.query('COMMIT');
    }
    record('C: recovery (re-push pending) reaches ALL state', ledgerStatus(await appliedVersions(c)) === 'all');
    // and the migrated schema now passes postflight
    let ok = true, msg = '';
    try { await c.query(prepared('postflight.sql')); } catch (e) { ok = false; msg = e.message.split('\n')[0]; }
    record('C: postflight passes after recovery', ok, ok ? '' : msg);
  } finally { await c.end(); }
}

// ---- D: full rehearsal + baseline-preserve + fixture/postflight/acl/ledger --
async function rehearsalD(admin) {
  console.log('\n[D] full rehearsal + baseline preserve + artifacts:');
  const c = await freshDb(admin, 'rehearse_d');
  try {
    await c.query(`INSERT INTO public.email_address_state(email,state)
      SELECT 'd'||g||'@ex.test', CASE WHEN g%7=0 THEN 'hard_bounced' ELSE 'ok' END FROM generate_series(1,500) g`);
    await c.query(`INSERT INTO public.email_delivery_events(recipient_email,event_type,occurred_at)
      SELECT 'd'||g||'@ex.test','sent', now() FROM generate_series(1,120) g`);
    const easPre = (await c.query('SELECT count(*)::int n FROM public.email_address_state')).rows[0].n;
    const edePre = (await c.query('SELECT count(*)::int n FROM public.email_delivery_events')).rows[0].n;
    // baseline.sql must parse/execute (operator persists its output pre/post)
    await c.query(preparedPlain('baseline.sql'));

    await applyPr615(c);

    const easPost = (await c.query('SELECT count(*)::int n FROM public.email_address_state')).rows[0].n;
    const edePost = (await c.query('SELECT count(*)::int n FROM public.email_delivery_events')).rows[0].n;
    record('D: baseline preserved — email_address_state row count', easPre === easPost, `${easPre} -> ${easPost}`);
    record('D: baseline preserved — email_delivery_events row count', edePre === edePost, `${edePre} -> ${edePost}`);
    await c.query(preparedPlain('baseline.sql'));       // post-migration baseline parses too

    for (const art of ['academy_fixture.sql', 'postflight.sql', 'acl_matrix.sql', 'ledger_verification.sql']) {
      let ok = true, msg = '';
      try { await c.query(prepared(art)); } catch (e) { ok = false; msg = e.message.split('\n')[0]; }
      record(`D: ${art} passes on full clone`, ok, ok ? '' : msg);
    }
  } finally { await c.end(); }
}

async function main() {
  console.log(`rollout rehearsals A/B/C/D — PR615 migrations pinned @ ${PR615_SHA.slice(0, 12)}`);
  const { epg, url, conn } = await boot(PORT);
  BASE_URL = url;
  const admin = conn(); await admin.connect();
  try {
    await rehearsalA(admin);
    await rehearsalB(admin);
    await rehearsalC(admin);
    await rehearsalD(admin);
    console.log(`\n================  ${PASS} passed, ${FAIL} failed  ================`);
  } finally {
    await admin.end().catch(() => {});
    await epg.stop().catch(() => {});
  }
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch((e) => { console.error('REHEARSAL HARNESS ERROR:', e); process.exit(2); });
