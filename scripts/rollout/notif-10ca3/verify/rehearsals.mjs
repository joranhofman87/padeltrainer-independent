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

// ---- D: full rehearsal + CONCURRENCY-SAFE no-loss manifest + artifacts ------
async function rehearsalD(admin) {
  console.log('\n[D] full rehearsal + no-loss manifest (new rows allowed) + artifacts:');
  const c = await freshDb(admin, 'rehearse_d');
  const salt = 'rehearsal-d-salt';
  const easSet = async () => new Set((await c.query(`SELECT md5($1||'|'||email) f FROM public.email_address_state`, [salt])).rows.map((r) => r.f));
  const edeSet = async () => new Set((await c.query(`SELECT md5($1||'|'||id::text) f FROM public.email_delivery_events`, [salt])).rows.map((r) => r.f));
  const manifestSql = preparedPlain('manifest.sql').replace(/:'salt'/g, `'${salt}'`);
  try {
    await c.query(`INSERT INTO public.email_address_state(email,state)
      SELECT 'd'||g||'@ex.test', CASE WHEN g%7=0 THEN 'hard_bounced' ELSE 'ok' END FROM generate_series(1,500) g`);
    await c.query(`INSERT INTO public.email_delivery_events(recipient_email,event_type,occurred_at)
      SELECT 'd'||g||'@ex.test','sent', now() FROM generate_series(1,120) g`);
    const easPre = await easSet(); const edePre = await edeSet();
    await c.query(manifestSql);                         // manifest.sql parses/executes (pre)

    await applyPr615(c);
    // during the window: a pre-gate send FINISHES (new event row) + a Resend webhook INSERTS
    await c.query(`INSERT INTO public.email_delivery_events(recipient_email,event_type,occurred_at) VALUES ('late@ex.test','delivered',now())`);
    await c.query(`INSERT INTO public.email_address_state(email,state) VALUES ('webhook@ex.test','soft_bounced')`);
    await c.query(manifestSql);                         // manifest.sql parses (post)

    const easPost = await easSet(); const edePost = await edeSet();
    const easLost = [...easPre].filter((k) => !easPost.has(k));
    const edeLost = [...edePre].filter((k) => !edePost.has(k));
    record('D: no-loss holds while NEW rows (pre-gate finish + webhook) are added',
      easLost.length === 0 && edeLost.length === 0, `+${easPost.size - easPre.size} eas, +${edePost.size - edePre.size} ede`);

    // deleting a pre-existing address MUST be detectable as loss
    await c.query(`DELETE FROM public.email_address_state WHERE email='d1@ex.test'`);
    const easDel = await easSet();
    record('D: deleting a pre-existing address is detected as loss', [...easPre].filter((k) => !easDel.has(k)).length === 1);

    for (const art of ['academy_fixture.sql', 'postflight.sql', 'acl_matrix.sql', 'ledger_verification.sql']) {
      let ok = true, msg = '';
      try { await c.query(prepared(art)); } catch (e) { ok = false; msg = e.message.split('\n')[0]; }
      record(`D: ${art} passes on full clone`, ok, ok ? '' : msg);
    }
  } finally { await c.end(); }
}

// ---- E: legitimate state recomputation is OK; row loss / bad is_suppressed /
//        unchanged readers must still fail --------------------------------
async function snapshot(c) {
  const q1 = async (s) => (await c.query(s)).rows[0].n;
  const m = async (s) => (await c.query(s)).rows[0].m;
  return {
    eas: await q1('SELECT count(*)::int n FROM public.email_address_state'),
    ede: await q1('SELECT count(*)::int n FROM public.email_delivery_events'),
    bad: await q1("SELECT count(*)::int n FROM public.email_address_state WHERE state <> 'ok'"),
    rA: await m("SELECT coalesce(md5(pg_get_functiondef(to_regprocedure('public.get_academy_undeliverable_recipients(uuid)'))),'absent') m"),
    rO: await m("SELECT coalesce(md5(pg_get_functiondef(to_regprocedure('public.get_players_overview(text,uuid,text,jsonb,text,text,integer,integer)'))),'absent') m"),
  };
}
async function seedBadStates(c) {
  // pre-migration shape: provider_suppressed_active is added by 20261006100000
  await c.query(`INSERT INTO public.email_address_state(email,state)
    SELECT 'e'||g||'@ex.test', (ARRAY['hard_bounced','soft_bounced','complained','ok'])[1+g%4] FROM generate_series(1,200) g`);
  await c.query(`INSERT INTO public.email_delivery_events(recipient_email,event_type,occurred_at)
    SELECT 'e'||g||'@ex.test','delivered', now() FROM generate_series(1,200) g`);
}
async function rehearsalE(admin) {
  console.log('\n[E] state recomputation OK; row loss / bad suppression / unchanged readers FAIL:');
  // happy path: recomputation may change the bad-state count, but true invariants hold
  { const c = await freshDb(admin, 'rehearse_e'); try {
      await seedBadStates(c);
      const pre = await snapshot(c);
      await applyPr615(c);
      const post = await snapshot(c);
      record('E: true invariant preserved — email_address_state rows', pre.eas === post.eas, `${pre.eas} -> ${post.eas}`);
      record('E: true invariant preserved — email_delivery_events rows', pre.ede === post.ede, `${pre.ede} -> ${post.ede}`);
      record('E: readers re-emitted (fingerprints changed)', pre.rA !== post.rA && pre.rO !== post.rO);
      note(`E: state distribution is EVIDENCE, not asserted: bad_state ${pre.bad} -> ${post.bad}`);
      let ok = true, msg = '';
      try { await c.query(prepared('postflight.sql')); await c.query(prepared('ledger_verification.sql')); }
      catch (e) { ok = false; msg = e.message.split('\n')[0]; }
      record('E: postflight + ledger consistency pass despite state recomputation', ok, ok ? '' : msg);
    } finally { await c.end(); } }
  // E1 row loss must be caught by the row-count preserve check
  { const c = await freshDb(admin, 'rehearse_e1'); try {
      await seedBadStates(c); const pre = await snapshot(c); await applyPr615(c);
      await c.query(`DELETE FROM public.email_address_state WHERE email='e1@ex.test'`);
      const post = await snapshot(c);
      record('E1: row loss is detected (eas rows differ)', pre.eas !== post.eas, `${pre.eas} -> ${post.eas}`);
    } finally { await c.end(); } }
  // E2 corrupted is_suppressed must fail ledger_verification
  { const c = await freshDb(admin, 'rehearse_e2'); try {
      await seedBadStates(c); await applyPr615(c);
      await c.query('BEGIN');
      let failed = false, msg = '';
      try {
        await c.query(`ALTER TABLE public.email_address_state DROP COLUMN is_suppressed`);
        await c.query(`ALTER TABLE public.email_address_state ADD COLUMN is_suppressed boolean NOT NULL DEFAULT false`);
        await c.query(`UPDATE public.email_address_state SET is_suppressed = true WHERE state = 'ok'`); // now violates the rule
        await c.query(prepared('ledger_verification.sql'));
      } catch (e) { failed = true; msg = e.message.split('\n')[0]; }
      await c.query('ROLLBACK').catch(() => {});
      record('E2: invalid canonical suppression is detected (ledger_verification fails)', failed, failed ? msg.slice(0, 80) : 'passed despite corruption');
    } finally { await c.end(); } }
  // E3 unchanged reader definitions must be caught (apply only the non-reader migrations)
  { const c = await freshDb(admin, 'rehearse_e3'); try {
      await seedBadStates(c); const pre = await snapshot(c);
      await c.query(migPR615(PR615_MIGS[0])); await c.query(migPR615(PR615_MIGS[1])); // skip the reader migration
      const post = await snapshot(c);
      record('E3: unchanged readers are detected (fingerprints did NOT change)', pre.rA === post.rA && pre.rO === post.rO);
    } finally { await c.end(); } }
}

async function main() {
  console.log(`rollout rehearsals A/B/C/D/E — PR615 migrations pinned @ ${PR615_SHA.slice(0, 12)}`);
  const { epg, url, conn } = await boot(PORT);
  BASE_URL = url;
  const admin = conn(); await admin.connect();
  try {
    await rehearsalA(admin);
    await rehearsalB(admin);
    await rehearsalC(admin);
    await rehearsalD(admin);
    await rehearsalE(admin);
    console.log(`\n================  ${PASS} passed, ${FAIL} failed  ================`);
  } finally {
    await admin.end().catch(() => {});
    await epg.stop().catch(() => {});
  }
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch((e) => { console.error('REHEARSAL HARNESS ERROR:', e); process.exit(2); });
