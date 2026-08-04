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
import { readFileSync, writeFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { boot, SQL_DIR, installPreState, applyPr615, migPR615, PR615_MIGS, REPO } from './chain.mjs';

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
  await c.query(`DROP TABLE IF EXISTS public.auth_probe_users`);

  console.log('\n[1b] APPLICATION state must fail the empty-project proof');
  for (const [label, setup, teardown] of [
    ['a customer table with a row',
     `CREATE TABLE public.customers (id int, email text); INSERT INTO public.customers VALUES (1,'a@b.test')`,
     `DROP TABLE IF EXISTS public.customers`],
    ['an empty application table',
     `CREATE TABLE public.leftovers (id int)`, `DROP TABLE IF EXISTS public.leftovers`],
    ['a view in public', `CREATE VIEW public.v_x AS SELECT 1 AS a`, `DROP VIEW IF EXISTS public.v_x`],
    ['a migration-ledger entry',
     `CREATE SCHEMA IF NOT EXISTS supabase_migrations;
      CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY);
      INSERT INTO supabase_migrations.schema_migrations VALUES ('20260101000000')`,
     `DELETE FROM supabase_migrations.schema_migrations`],
    ['a storage bucket',
     `CREATE SCHEMA IF NOT EXISTS storage;
      CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text);
      INSERT INTO storage.buckets VALUES ('avatars','avatars')`,
     `DELETE FROM storage.buckets`],
  ]) {
    try { await c.query(setup); } catch (x) { rec(`setup for ${label}`, false, String(x.message).slice(0, 80)); continue; }
    const e2 = await tryArtifact(c, 'empty_project_check.sql');
    rec(`empty_project_check REFUSES a target with ${label}`, e2 !== null, e2 ? '' : 'ACCEPTED');
    await c.query(teardown).catch(() => {});
  }
  // and the mutant: without the application-state check the customer table passes
  {
    await c.query(`CREATE TABLE public.customers (id int, email text); INSERT INTO public.customers VALUES (1,'a@b.test')`);
    const full = artifactText('empty_project_check.sql');
    const stripped = full.replace(/-- \(6\) NO APPLICATION STATE[\s\S]*?END \$\$;\n/, '');
    let mutErr = null;
    try { await c.query(stripped); } catch (x) { mutErr = x; await c.query('ROLLBACK').catch(() => {}); }
    rec('MUTANT (application-state check removed) ACCEPTS a project holding a customer table — the check is load-bearing',
        mutErr === null, mutErr ? String(mutErr.message).slice(0, 70) : '');
    await c.query(`DROP TABLE IF EXISTS public.customers`);
  }

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
    source: 'measured', measured_at: '2026-08-02', byte_tolerance_pct: 20,
    tables: {
      email_address_state: { rows: 4000, avg_email_len: 32, avg_reason_len: 24,
        heap_bytes: 483328, index_bytes: 425984, total_bytes: 942080,
        state_distribution: { ok: 3600, soft_bounced: 200, hard_bounced: 120, complained: 80 } },
      email_delivery_events: { rows: 12000, avg_reason_len: 24, resend_event_id_pct: 60, with_invoice_pct: 40,
        heap_bytes: 1916928, index_bytes: 2162688, total_bytes: 4112384,
        event_type_distribution: { sent: 7000, delivered: 3500, bounced: 900, complained: 300,
                                   delivery_delayed: 150, failed: 100, send_failed: 50 },
        events_per_address: { p50: 2, p90: 6, max: 20 } },
    },
    bloat: { email_address_state: 0.1, email_delivery_events: 0.05 },
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
  } catch (x) {
    const detail = `${String(x.stdout || '').match(/BYTES[^\n]*/g)?.join(' | ') || ''} ${String(x.stderr || x)}`;
    rec('the synthetic generator loads a production-scale baseline', false, detail.slice(0, 700));
  }
  rec('email_address_state loaded to the configured scale',
      await scalar(c, `SELECT count(*)::int AS v FROM public.email_address_state`) === 4000);
  rec('email_delivery_events loaded to the configured scale',
      await scalar(c, `SELECT count(*)::int AS v FROM public.email_delivery_events`) === 12000);
  rec('every address is on the reserved undeliverable TLD — no customer identifier exists in the target',
      await scalar(c, `SELECT ((SELECT count(*) FROM public.email_address_state WHERE email NOT LIKE '%@%.example.invalid')
                            + (SELECT count(*) FROM public.email_delivery_events WHERE recipient_email NOT LIKE '%@%.example.invalid'))::int AS v`) === 0);
  const other = await scalar(c, `SELECT count(*)::int AS v FROM public.notification_outbox`);
  rec('ONLY the two affected tables received scale data (notification_outbox untouched)', other === 0);

  // …and the envelope check must have TEETH: the same load with a deliberately
  // wrong measured size has to be refused, or the "ok" above means nothing.
  {
    const bad = JSON.parse(JSON.stringify(scale));
    bad.tables.email_address_state.total_bytes = Math.round(bad.tables.email_address_state.total_bytes * 2);
    const badFile = join(dir, 'scale-bad.json');
    writeFileSync(badFile, JSON.stringify(bad));
    let refused = false;
    try {
      execFileSync('node', [join(REPO, 'scripts/rollout/notif-10ca3/synth/build-baseline.mjs'), url, badFile],
        { encoding: 'utf8', env: { ...process.env, PGPASSWORD: 'postgres' } });
    } catch { refused = true; }
    rec('a baseline 2x outside the measured byte envelope is REFUSED (the check has teeth)', refused);
  }
  rec('with_invoice_pct is enforced, not merely declared — invoice_id is populated',
      Number(await scalar(c, `SELECT count(*)::int AS v FROM public.email_delivery_events WHERE invoice_id IS NOT NULL`)) > 0);
  rec('…and resend_event_id_pct likewise',
      Number(await scalar(c, `SELECT count(*)::int AS v FROM public.email_delivery_events WHERE resend_event_id IS NOT NULL`)) > 0);
  rec('the per-address event history is not uniform (the backfill cost follows it)',
      Number(await scalar(c, `SELECT (max(n) - min(n))::int AS v FROM
        (SELECT count(*) n FROM public.email_delivery_events GROUP BY recipient_email) x`)) > 0);

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

  // ---- the lock proof that matters: run the REAL migration while another
  //      session holds a conflicting lock, and require it to abort cleanly ----
  console.log('\n[5b] the ADVERTISED lifecycle: sanitize -> full chain -> #615 -> wipe -> rebuild');
  {
    const sanDir = mkdtempSync(join(tmpdir(), 'rollout-san-'));
    const out = execFileSync('node', [join(REPO, 'scripts/rollout/notif-10ca3/synth/sanitize-migrations.mjs'),
      join(REPO, 'supabase/migrations'), join(sanDir, 'migrations')], { encoding: 'utf8' });
    rec('the migration chain sanitizes (pg_cron/pg_net CREATE EXTENSION neutralised)',
        /neutralised_extension_statements=[1-9]/.test(out), out.trim().slice(0, 90));

    const fresh = conn(); await fresh.connect();
    const applyChain = async (cl) => {
      const files = readdirSync(join(sanDir, 'migrations')).filter(f => f.endsWith('.sql')).sort();
      let n = 0;
      for (const f of files) { await cl.query(readFileSync(join(sanDir, 'migrations', f), 'utf8')); n++; }
      return { n, total: files.length };
    };
    try {
      // bare project -> stub -> FULL chain, exactly as clone-build-baseline does it
      await fresh.query(`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS auth CASCADE;
        DROP SCHEMA IF EXISTS storage CASCADE; DROP SCHEMA IF EXISTS vault CASCADE;
        DROP SCHEMA IF EXISTS cron CASCADE; DROP SCHEMA IF EXISTS net CASCADE; CREATE SCHEMA public;
        DROP PUBLICATION IF EXISTS supabase_realtime;`);
      await fresh.query(`CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY)`)
        .catch(async () => { await fresh.query(`CREATE SCHEMA IF NOT EXISTS supabase_migrations;
          CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY)`); });
      await fresh.query(`DELETE FROM supabase_migrations.schema_migrations`);
      await runArtifact(fresh, 'platform_stub.sql');
      const r1 = await applyChain(fresh);
      rec(`the FULL sanitized chain applies to a bare project (${r1.n}/${r1.total})`, r1.n === r1.total);
      rec('…and pg_cron / pg_net are NOT installed on the result',
          await scalar(fresh, `SELECT count(*)::int AS v FROM pg_extension WHERE extname IN ('pg_cron','pg_net')`) === 0);
      // The safety property is ZERO ACTIVE, not "some recorded": the chain both
      // schedules and unschedules, so the surviving count is incidental.
      const scheduled = await scalar(fresh, `SELECT count(*)::int AS v FROM cron.job`);
      rec(`…and ZERO cron jobs are active on the result (${scheduled} recorded by the stand-in)`,
          await scalar(fresh, `SELECT count(*)::int AS v FROM cron.job WHERE active`) === 0);
      rec('…the stand-in was actually exercised — the chain reached it rather than a real extension',
          await scalar(fresh, `SELECT count(*)::int AS v FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                               WHERE n.nspname='cron' AND p.proname='schedule'`) >= 1);
      rec('…and nothing reached the network', await scalar(fresh, `SELECT count(*)::int AS v FROM net.blocked_outbound_attempts`) >= 0
          && await scalar(fresh, `SELECT count(*)::int AS v FROM net.http_request_queue`) === 0);
      const buckets = await scalar(fresh, `SELECT count(*)::int AS v FROM storage.buckets`);
      rec(`…the chain created storage state that a naive wipe would leave behind (${buckets} bucket(s))`, buckets > 0);

      // THE GENERATOR AGAINST THE REAL MIGRATED SCHEMA. Previously it was only
      // ever exercised against the simplified pre-state, where `invoices` has a
      // single `id` column — so its invoice insert could never have run here.
      const fullScale = JSON.parse(JSON.stringify(scale));
      fullScale.tables.email_address_state.rows = 800;
      fullScale.tables.email_delivery_events.rows = 2400;
      fullScale.byte_tolerance_pct = 20;
      const fsFile = join(sanDir, 'scale-full.json');
      let genOut = '', genErr = null;
      // learn this schema's real sizes, then pin them, so the envelope check is
      // exercised rather than skipped
      for (const pass of [1, 2]) {
        writeFileSync(fsFile, JSON.stringify(fullScale));
        try {
          genOut = execFileSync('node', [join(REPO, 'scripts/rollout/notif-10ca3/synth/build-baseline.mjs'), url, fsFile],
            { encoding: 'utf8', env: { ...process.env, PGPASSWORD: 'postgres' } });
          genErr = null; break;
        } catch (x) {
          genErr = x;
          const seen = String(x.stdout || '').match(/BYTES (\S+)\.(\w+) generated=(\d+)/g) || [];
          if (pass === 2 || !seen.length) break;
          for (const line of seen) {
            const [, t, what, got] = line.match(/BYTES (\S+)\.(\w+) generated=(\d+)/);
            fullScale.tables[t][`${what}_bytes`] = Number(got);
          }
        }
      }
      rec('the synthetic generator runs against the FULL migrated schema',
          genErr === null, genErr ? String(genErr.stdout || genErr.stderr || genErr).slice(0, 200) : genOut.trim().slice(0, 70));
      rec('…creating a VALID invoice parent graph (trainer_id, invoice_number, due_date, player_name are NOT NULL)',
          Number(await scalar(fresh, `SELECT count(*)::int AS v FROM public.invoices`)) > 0);
      rec('…and linking events to it, so with_invoice_pct is real',
          Number(await scalar(fresh, `SELECT count(*)::int AS v FROM public.email_delivery_events WHERE invoice_id IS NOT NULL`)) > 0);
      rec('…with every synthetic address still undeliverable',
          Number(await scalar(fresh, `SELECT ((SELECT count(*) FROM public.email_address_state WHERE email NOT LIKE '%@%.example.invalid')
                 + (SELECT count(*) FROM public.email_delivery_events WHERE recipient_email NOT LIKE '%@%.example.invalid'))::int AS v`)) === 0);

      // ---- a failed byte envelope must ROLL BACK, proven by a SENTINEL ----
      // Row counts alone cannot show this: the loader TRUNCATEs and reloads the
      // same number of rows, so a commit-before-validate ordering produces 2400
      // rows too. A sentinel row inserted BEFORE the load is truncated by it and
      // only comes back if the transaction rolled back.
      {
        const SENT = 'rollback-sentinel@rehearsal.example.invalid';
        await fresh.query(`INSERT INTO public.email_address_state (email, state) VALUES ($1,'ok')
                           ON CONFLICT (email) DO NOTHING`, [SENT]);
        const hasSent = async (cl) => Number(await scalar(cl,
          `SELECT count(*)::int AS v FROM public.email_address_state WHERE email = '${SENT}'`)) === 1;
        rec('sentinel seeded before the failing load', await hasSent(fresh));

        const badScale = JSON.parse(JSON.stringify(fullScale));
        badScale.tables.email_address_state.total_bytes =
          Math.round(badScale.tables.email_address_state.total_bytes * 3);
        const badFile = join(sanDir, 'scale-envelope-fail.json');
        writeFileSync(badFile, JSON.stringify(badScale));
        let refused = false;
        try {
          execFileSync('node', [join(REPO, 'scripts/rollout/notif-10ca3/synth/build-baseline.mjs'), url, badFile],
            { encoding: 'utf8', env: { ...process.env, PGPASSWORD: 'postgres' } });
        } catch { refused = true; }
        rec('a load that fails the byte envelope is REFUSED', refused);
        rec('…and ROLLED BACK — the sentinel the load truncated is back', await hasSent(fresh));

        // MUTANT: commit before validating, the pre-fix ordering
        // beside the real one: a mutant in a temp dir cannot resolve `import pg`,
        // so it would exit before running and the sentinel would survive for the
        // wrong reason (which is exactly what happened the first time).
        const mut = join(REPO, 'scripts/rollout/notif-10ca3/synth/.commit-first-mutant.mjs');
        {
          // the pre-fix ordering, built by exact string surgery: commit BEFORE
          // the envelope check, and drop the compensating rollback
          const src = readFileSync(join(REPO, 'scripts/rollout/notif-10ca3/synth/build-baseline.mjs'), 'utf8');
          const beforeDrift = '  let drift = false;';
          const rollbackInDrift = "  if (drift) {\n    await c.query('ROLLBACK');";
          if (!src.includes(beforeDrift) || !src.includes(rollbackInDrift)) {
            rec('the commit-first mutant could be built (anchors still present)', false, 'anchors moved');
          }
          let m = src.replace(beforeDrift, "  await c.query('COMMIT');\n" + beforeDrift);
          m = m.replace(rollbackInDrift, '  if (drift) {');
          m = m.replace("  // validated: now it may become durable\n  await c.query('COMMIT');", '  // validated (mutant: already committed)');
          writeFileSync(mut, m);
        }
        await fresh.query(`INSERT INTO public.email_address_state (email, state) VALUES ($1,'ok')
                           ON CONFLICT (email) DO NOTHING`, [SENT]);
        let mutRefused = false;
        try {
          execFileSync('node', [mut, url, badFile],
            { encoding: 'utf8', env: { ...process.env, PGPASSWORD: 'postgres' } });
        } catch { mutRefused = true; }
        const sentSurvived = await hasSent(fresh);
        rec('MUTANT (COMMIT hoisted above validation) still refuses…', mutRefused);
        rec('…but the sentinel is GONE — it committed the failed load, which is exactly the stranding this fix prevents',
            sentSurvived === false, `sentinel present=${sentSurvived}`);
        rmSync(mut, { force: true });

        // put the target back for the assertions that follow
        execFileSync('node', [join(REPO, 'scripts/rollout/notif-10ca3/synth/build-baseline.mjs'), url, fsFile],
          { encoding: 'utf8', env: { ...process.env, PGPASSWORD: 'postgres' } });
      }

      // ---- bloat must actually be injected ----
      {
        const out = execFileSync('node', [join(REPO, 'scripts/rollout/notif-10ca3/synth/build-baseline.mjs'), url, fsFile],
          { encoding: 'utf8', env: { ...process.env, PGPASSWORD: 'postgres' } });
        const m = out.match(/BLOAT email_address_state ratio=([\d.]+) rows_updated=(\d+) of (\d+)/);
        rec('the generator reports its bloat injection', m !== null, (out.match(/BLOAT[^\n]*/) || [''])[0]);
        if (m) {
          const [, r, updated, rows] = m;
          rec(`…and honours dead_tuple_ratio (${r} of ${rows} = ${Math.round(Number(rows) * Number(r))}, updated ${updated})`,
              Number(updated) === Math.max(1, Math.round(Number(rows) * Number(r))) && Number(updated) > 0);
        }
        // PHYSICAL PROOF, not the generator's own message: a mutant that skips
        // the UPDATE and prints the expected line would pass a message check.
        await fresh.query('ANALYZE public.email_address_state');
        await fresh.query('ANALYZE public.email_delivery_events');
        const dead = async (t) => Number(await scalar(fresh,
          `SELECT coalesce(n_dead_tup, 0)::int AS v FROM pg_stat_user_tables WHERE schemaname='public' AND relname='${t}'`));
        const d1 = await dead('email_address_state'), d2 = await dead('email_delivery_events');
        rec(`bloat is PHYSICALLY present in email_address_state (n_dead_tup=${d1})`, d1 > 0);
        rec(`…and in email_delivery_events (n_dead_tup=${d2}) — the ratio is per-table, matching the sizing query`, d2 > 0);

        // MUTANT: skip the UPDATE, keep the message
        const bmut = join(REPO, 'scripts/rollout/notif-10ca3/synth/.no-bloat-mutant.mjs');
        {
          const src = readFileSync(join(REPO, 'scripts/rollout/notif-10ca3/synth/build-baseline.mjs'), 'utf8');
          writeFileSync(bmut, src.replace('      updated = res.rowCount;', '      updated = want;   // MUTANT: report it, do not do it')
                                 .replace(/      const res = await c\.query\(\n        `UPDATE public\.\$\{t\}[\s\S]*?\[want\]\);\n/, ''));
        }
        execFileSync('node', [bmut, url, fsFile], { encoding: 'utf8', env: { ...process.env, PGPASSWORD: 'postgres' } });
        await fresh.query('ANALYZE public.email_address_state');
        const mDead = await dead('email_address_state');
        rec('MUTANT (UPDATE removed, message kept) leaves ZERO dead tuples — the physical check catches what a message check would not',
            mDead === 0, `n_dead_tup=${mDead}`);
        rmSync(bmut, { force: true });

        const badBloat = JSON.parse(JSON.stringify(fullScale));
        badBloat.bloat = {};                       // ratios absent entirely
        const bf = join(sanDir, 'scale-nobloat.json');
        writeFileSync(bf, JSON.stringify(badBloat));
        let bloatRefused = false;
        try {
          execFileSync('node', [join(REPO, 'scripts/rollout/notif-10ca3/synth/build-baseline.mjs'), url, bf],
            { encoding: 'utf8', env: { ...process.env, PGPASSWORD: 'postgres' } });
        } catch { bloatRefused = true; }
        rec('a scale file with NO per-table bloat ratios is refused (the ADR promises injected bloat)', bloatRefused);
        execFileSync('node', [join(REPO, 'scripts/rollout/notif-10ca3/synth/build-baseline.mjs'), url, fsFile],
          { encoding: 'utf8', env: { ...process.env, PGPASSWORD: 'postgres' } });
      }

      // ---- F2: the generated history matches the BACKFILL predicate ----
      {
        const PRED = `event_type IN ('sent','delivered','bounced','complained','operator_reset')`;
        const h = (await fresh.query(`
          SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY n)::int AS p50,
                 percentile_disc(0.9) WITHIN GROUP (ORDER BY n)::int AS p90,
                 max(n)::int AS mx
          FROM (SELECT count(*) AS n FROM public.email_delivery_events
                 WHERE ${PRED} GROUP BY recipient_email) x`)).rows[0];
        const want = fullScale.tables.email_delivery_events.events_per_address;
        rec(`the FILTERED p50 matches the configured history (${h.p50} vs ${want.p50})`, h.p50 === want.p50);
        rec(`…p90 matches (${h.p90} vs ${want.p90})`, h.p90 === want.p90);
        rec(`…and max matches EXACTLY (${h.mx} vs ${want.max}) — "<=" would pass a generator that never reaches the measured maximum`,
            h.mx === want.max);

        const total = Number(await scalar(fresh, `SELECT count(*)::int AS v FROM public.email_delivery_events`));
        rec(`the measured total row count is preserved (${total})`,
            total === fullScale.tables.email_delivery_events.rows);
        const dist = fullScale.tables.email_delivery_events.event_type_distribution;
        const sum = Object.values(dist).reduce((a, b) => a + b, 0);
        const got = Object.fromEntries((await fresh.query(
          `SELECT event_type, count(*)::int AS n FROM public.email_delivery_events GROUP BY event_type`))
          .rows.map((r) => [r.event_type, r.n]));
        // EXACT: the generator apportions by largest remainder, so every type
        // must match its measured share to the row. A tolerance here would only
        // hide drift.
        const bad = [];
        const wantCounts = (() => {
          const ex = Object.entries(dist).map(([k, w]) => [k, total * w / sum]);
          const o = Object.fromEntries(ex.map(([k, v]) => [k, Math.floor(v)]));
          let left = total - Object.values(o).reduce((a, b) => a + b, 0);
          for (const [k] of ex.map(([k, v]) => [k, v - Math.floor(v)]).sort((a, b) => b[1] - a[1])) {
            if (left <= 0) break; o[k]++; left--;
          }
          return o;
        })();
        for (const [t, w] of Object.entries(wantCounts)) {
          if ((got[t] || 0) !== w) bad.push(`${t}: got ${got[t] || 0}, want ${w}`);
        }
        rec('every event type matches its measured share EXACTLY (apportioned, not sampled)',
            bad.length === 0, bad.join('; '));

        const nonProducing = Number(await scalar(fresh,
          `SELECT count(*)::int AS v FROM public.email_delivery_events WHERE NOT (${PRED})`));
        rec(`non-producing types are allocated SEPARATELY, not out of the history budget (${nonProducing} rows)`,
            nonProducing > 0);
      }

      // apply #615, exactly as rehearsal A does
      await applyPr615(fresh);
      rec('#615 applies on top of the freshly built chain',
          await scalar(fresh, `SELECT count(*)::int AS v FROM information_schema.columns
                               WHERE table_name='email_address_state' AND column_name='is_suppressed'`) === 1);
      await fresh.query(`INSERT INTO supabase_migrations.schema_migrations
        SELECT unnest(ARRAY['20261006100000','20261006110000','20261006120000'])`);

      // THE RESET: wipe -> prove bare -> rebuild the FULL chain again
      await runArtifact(fresh, 'clone_wipe.sql');
      rec('the wipe clears the storage buckets a schema drop cannot reach',
          await scalar(fresh, `SELECT count(*)::int AS v FROM storage.buckets`) === 0);
      rec('…and every storage policy the chain created',
          await scalar(fresh, `SELECT count(*)::int AS v FROM pg_policies WHERE schemaname='storage' AND tablename='objects'`) === 0);
      rec('…and the migration ledger, so the rebuild is the FULL chain not a suffix',
          await scalar(fresh, `SELECT count(*)::int AS v FROM supabase_migrations.schema_migrations`) === 0);
      let e2 = await tryArtifact(fresh, 'empty_project_check.sql');
      rec('the wiped target passes the empty-project proof again', e2 === null, e2?.message.slice(0, 80));

      // The WIPE is what this step proves, so assert the reset BEFORE the rebuild. This used to
      // be asserted after the rebuild, back when #615 was an overlay applied on top of a
      // pre-#615 chain. #615 has since LANDED in main (20261006100000 adds is_suppressed), so
      // the full chain now creates that column itself and "absent after rebuild" became
      // permanently false — an assertion that could only be satisfied by the chain being
      // incomplete. Splitting it keeps the original intent and actually strengthens it: the wipe
      // must clear the column, and the rebuild must bring it back.
      rec('…and the wipe removed the migrated column, so the target is genuinely pre-migration',
          await scalar(fresh, `SELECT count(*)::int AS v FROM information_schema.columns
                               WHERE table_name='email_address_state' AND column_name='is_suppressed'`) === 0);

      await runArtifact(fresh, 'platform_stub.sql');
      const r2 = await applyChain(fresh);
      rec(`the FULL chain REPLAYS after the wipe (${r2.n}/${r2.total}) — no duplicate bucket, no duplicate policy`,
          r2.n === r2.total);
      rec('…and the replay REBUILDS the migrated column — proving a full chain, not a suffix',
          await scalar(fresh, `SELECT count(*)::int AS v FROM information_schema.columns
                               WHERE table_name='email_address_state' AND column_name='is_suppressed'`) === 1);
      // the generator must run on the REBUILT schema too — a reset that leaves a
      // target the loader cannot fill is not a reset
      let genErr2 = null;
      try {
        execFileSync('node', [join(REPO, 'scripts/rollout/notif-10ca3/synth/build-baseline.mjs'), url, fsFile],
          { encoding: 'utf8', env: { ...process.env, PGPASSWORD: 'postgres' } });
      } catch (x) { genErr2 = x; }
      rec('the generator runs again on the REBUILT schema — the full cycle closes',
          genErr2 === null, genErr2 ? String(genErr2.stdout || genErr2.stderr || genErr2).slice(0, 180) : '');
    } catch (x) {
      rec('the advertised build/wipe/rebuild lifecycle completes', false, String(x.message).slice(0, 160));
    } finally { await fresh.end().catch(() => {}); rmSync(sanDir, { recursive: true, force: true }); }
  }

  console.log('\n[6] the real migration under contention: abort, and ZERO delta');
  const holder = conn(); await holder.connect();
  const runner = conn(); await runner.connect();
  try {
    // rebuild a pre-#615 target so the migration has real work to do
    // installPreState also builds auth.*, so that schema must go too or it
    // collides on re-install
    await c.query(`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS auth CASCADE;
                   CREATE SCHEMA public`);
    await c.query(`DELETE FROM supabase_migrations.schema_migrations`).catch(() => {});
    await installPreState(c);
    await c.query(`INSERT INTO public.email_address_state (email, state)
                   SELECT 's'||g||'@rehearsal.example.invalid', 'ok' FROM generate_series(1, 2000) g`);
    const shapeBefore = (await allRows(c, fp1)).find(x => /^SHAPE /.test(x));
    const fnBefore = await scalar(c, `SELECT count(*)::int AS v FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'`);
    const colBefore = await scalar(c, `SELECT count(*)::int AS v FROM information_schema.columns
                                       WHERE table_name='email_address_state' AND column_name='is_suppressed'`);

    // a reader holds the table; the migration cannot get ACCESS EXCLUSIVE
    await holder.query('BEGIN');
    await holder.query(`SELECT count(*) FROM public.email_address_state`);
    await runner.query(`SET lock_timeout = '800ms'`);
    // The CLI applies a migration AND records it in the ledger in ONE transaction.
    // Testing only the migration would make "zero ledger delta" true no matter
    // what, so the ledger insert is included here exactly as the CLI does it.
    let err = null;
    try {
      await runner.query('BEGIN');
      await runner.query(migPR615(PR615_MIGS[0]));
      await runner.query(`INSERT INTO supabase_migrations.schema_migrations (version) VALUES ($1)`,
        [PR615_MIGS[0].slice(0, 14)]);
      await runner.query('COMMIT');
    } catch (x) { err = x; await runner.query('ROLLBACK').catch(() => {}); }
    rec('the REAL migration ABORTS on lock_timeout while a reader holds the table',
        err !== null && err.code === '55P03', err ? err.code : 'IT COMMITTED');
    await holder.query('COMMIT');

    const shapeAfter = (await allRows(c, fp1)).find(x => /^SHAPE /.test(x));
    const fnAfter = await scalar(c, `SELECT count(*)::int AS v FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'`);
    const colAfter = await scalar(c, `SELECT count(*)::int AS v FROM information_schema.columns
                                      WHERE table_name='email_address_state' AND column_name='is_suppressed'`);
    rec('…leaving ZERO schema delta (shape fingerprint unchanged)', shapeBefore === shapeAfter,
        `${shapeBefore?.slice(0, 12)} vs ${shapeAfter?.slice(0, 12)}`);
    rec('…zero function delta', fnBefore === fnAfter, `${fnBefore} -> ${fnAfter}`);
    rec('…and the generated column was NOT added', colBefore === 0 && colAfter === 0);
    const ledger = await scalar(c, `SELECT count(*)::int AS v FROM supabase_migrations.schema_migrations`).catch(() => 0);
    rec('…and zero ledger delta — the ledger INSERT was in the same transaction, so this is not vacuous',
        Number(ledger) === 0, `ledger=${ledger}`);
    // and prove the ledger write would otherwise have landed: same statement, no contention
    await c.query(`INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('ledger-probe')`);
    rec('…(control: an uncontended ledger insert DOES land, so the assertion has teeth)',
        Number(await scalar(c, `SELECT count(*)::int AS v FROM supabase_migrations.schema_migrations`)) === 1);
    await c.query(`DELETE FROM supabase_migrations.schema_migrations`);

    // uncontended, the same migration succeeds — so the abort was the lock, not the SQL
    const t1 = process.hrtime.bigint();
    await c.query(migPR615(PR615_MIGS[0]));
    const ms1 = Number(process.hrtime.bigint() - t1) / 1e6;
    rec('uncontended, the same migration APPLIES — the abort was contention, not broken SQL',
        await scalar(c, `SELECT count(*)::int AS v FROM information_schema.columns
                         WHERE table_name='email_address_state' AND column_name='is_suppressed'`) === 1,
        `${ms1.toFixed(0)} ms over 2k rows`);
  } finally { await holder.end().catch(() => {}); await runner.end().catch(() => {}); }

  // ── the inventory PRODUCER refuses to emit a forgeable identity record ──────────────────
  // The reader-side guard is unit-tested in verify/inventory-parse-test.sh, but that suite feeds
  // it fabricated records — so removing the CASE from the SQL left every one of its checks green.
  // This runs the REAL artifact against a REAL server with hostile names planted, which is the
  // only way the producer's half is actually exercised. A NEWLINE-bearing name matters most: it
  // can otherwise form a perfectly well-formed four-field first line that the field-count check
  // cannot see.
  await c.query(`DELETE FROM cron.job;
    INSERT INTO cron.job (schedule, command, jobname) VALUES
      ('* * * * *', 'SELECT 1;', 'notification-email-worker filler yes'),
      ('* * * * *', 'SELECT 1;', E'ok-name\nCRONJOB notification-email-worker true yes'),
      ('* * * * *', 'SELECT 1;', 'perfectly-fine-name');`);
  const invOut = await allRows(c, artifactText('clone_source_inventory.sql'));
  const cronRecords = invOut.filter((r) => typeof r === 'string' && r.startsWith('CRONJOB'));
  rec('the inventory emits CRONJOB_UNSAFE_NAME for a whitespace job name',
      cronRecords.filter((r) => r.startsWith('CRONJOB_UNSAFE_NAME ')).length === 2,
      cronRecords.join(' | '));
  rec('...and never emits the forged reviewed record',
      !cronRecords.some((r) => /^CRONJOB notification-email-worker /.test(r)),
      cronRecords.join(' | '));
  rec('...while a safe name still produces its ordinary record',
      cronRecords.some((r) => r.startsWith('CRONJOB perfectly-fine-name ')),
      cronRecords.join(' | '));
  await c.query(`DELETE FROM cron.job`);

  // ...and the same for OUTFN, which had the identical defect. A newline-bearing FUNCTION name is
  // the analogous field-count bypass, and the signature is what stops an overload reading as the
  // reviewed zero-argument function.
  await c.query(`
    CREATE OR REPLACE FUNCTION public.outfn_probe_ok() RETURNS void LANGUAGE plpgsql AS
      $f$ BEGIN PERFORM net.http_post('u'); END $f$;
    CREATE OR REPLACE FUNCTION public.outfn_probe_ok(p text) RETURNS void LANGUAGE plpgsql AS
      $f$ BEGIN PERFORM net.http_post('u'); END $f$;
    CREATE OR REPLACE FUNCTION public."outfn probe hostile" () RETURNS void LANGUAGE plpgsql AS
      $f$ BEGIN PERFORM net.http_post('u'); END $f$;
    -- A TYPE whose name contains spaces. Deleting every space from the signature made the two
    -- domains below serialise identically, so one reviewed identity could stand in for the other.
    -- (No backticks in this comment: it lives inside a JS template literal.)
    CREATE DOMAIN public."a b" AS text;
    CREATE DOMAIN public."a  b" AS text;
    CREATE DOMAIN public."a, b" AS text;
    CREATE DOMAIN public."a,b" AS text;
    -- A type name containing a literal % — without escaping % first, this encodes to the SAME
    -- text as the space-bearing name above, so the encoding would not be injective.
    CREATE DOMAIN public."a%20b" AS text;
    -- OVERLOADS SHARING ONE NAME, so the records differ ONLY in the signature. Two distinctly
    -- named functions would have made the comparison below trivially true whatever the encoder did.
    CREATE OR REPLACE FUNCTION public.outfn_pair(p public."a b") RETURNS void LANGUAGE plpgsql AS
      $f$ BEGIN PERFORM net.http_post('u'); END $f$;
    CREATE OR REPLACE FUNCTION public.outfn_pair(p public."a  b") RETURNS void LANGUAGE plpgsql AS
      $f$ BEGIN PERFORM net.http_post('u'); END $f$;
    CREATE OR REPLACE FUNCTION public.outfn_pair(p public."a, b") RETURNS void LANGUAGE plpgsql AS
      $f$ BEGIN PERFORM net.http_post('u'); END $f$;
    CREATE OR REPLACE FUNCTION public.outfn_pair(p public."a,b") RETURNS void LANGUAGE plpgsql AS
      $f$ BEGIN PERFORM net.http_post('u'); END $f$;
    CREATE OR REPLACE FUNCTION public.outfn_pair(p public."a%20b") RETURNS void LANGUAGE plpgsql AS
      $f$ BEGIN PERFORM net.http_post('u'); END $f$;
    -- ARGUMENT ORDER is part of the identity: these are two different functions.
    CREATE OR REPLACE FUNCTION public.outfn_pair(a text, b integer) RETURNS void LANGUAGE plpgsql AS
      $f$ BEGIN PERFORM net.http_post('u'); END $f$;
    CREATE OR REPLACE FUNCTION public.outfn_pair(a integer, b text) RETURNS void LANGUAGE plpgsql AS
      $f$ BEGIN PERFORM net.http_post('u'); END $f$;
    CREATE OR REPLACE FUNCTION public.outfn_varchar(p character varying) RETURNS void LANGUAGE plpgsql AS
      $f$ BEGIN PERFORM net.http_post('u'); END $f$;`);
  const invOut2 = await allRows(c, artifactText('clone_source_inventory.sql'));
  const outfn = invOut2.filter((r) => typeof r === 'string' && r.startsWith('OUTFN'));
  rec('the inventory emits OUTFN_UNSAFE_NAME for a whitespace function name',
      outfn.some((r) => r.startsWith('OUTFN_UNSAFE_NAME ')), outfn.join(' | '));
  rec('...and never emits a bare, forgeable OUTFN record',
      !outfn.some((r) => /^OUTFN [^(]+$/.test(r)), outfn.join(' | '));
  rec('...and distinguishes an OVERLOAD by its signature',
      outfn.includes('OUTFN public.outfn_probe_ok()') && outfn.includes('OUTFN public.outfn_probe_ok(text)'),
      outfn.join(' | '));
  // Every global rewrite tried here was lossy in the same way. `outfn_pair` has FOUR overloads
  // whose type names differ only by a space or a comma, so the four records differ only in the
  // parenthesised signature — and a collapse makes two of them identical.
  const pairSigs = outfn.filter((r) => r.startsWith('OUTFN public.outfn_pair('))
    .map((r) => r.slice('OUTFN public.outfn_pair'.length));
  rec('seven overloads keep SEVEN distinct signatures (space, comma, literal %, and arg ORDER)',
      pairSigs.length === 7 && new Set(pairSigs).size === 7, pairSigs.join(' vs '));
  // ...and a type name that legitimately contains a space must still come through, or the
  // encoder would have "fixed" the collisions by refusing every varchar signature.
  const varcharSig = outfn.find((r) => r.startsWith('OUTFN public.outfn_varchar(')) ?? '';
  rec('...and an ordinary space-bearing builtin type still serialises readably',
      varcharSig === 'OUTFN public.outfn_varchar(character%20varying)', varcharSig);
  await c.query(`DROP FUNCTION public.outfn_probe_ok(); DROP FUNCTION public.outfn_probe_ok(text);
                 DROP FUNCTION public."outfn probe hostile"();
                 DROP FUNCTION public.outfn_pair(public."a b");
                 DROP FUNCTION public.outfn_pair(public."a  b");
                 DROP FUNCTION public.outfn_pair(public."a, b");
                 DROP FUNCTION public.outfn_pair(public."a,b");
                 DROP FUNCTION public.outfn_pair(public."a%20b");
                 DROP FUNCTION public.outfn_pair(text, integer);
                 DROP FUNCTION public.outfn_pair(integer, text);
                 DROP FUNCTION public.outfn_varchar(character varying);
                 DROP DOMAIN public."a b"; DROP DOMAIN public."a  b";
                 DROP DOMAIN public."a, b"; DROP DOMAIN public."a,b"; DROP DOMAIN public."a%20b";`);
} finally {
  await c.end().catch(() => {}); await epg.stop().catch(() => {});
}
console.log(`\n================  ${PASS} passed, ${FAIL} failed  ================`);
process.exit(FAIL === 0 ? 0 : 1);
