// @vitest-environment node
// 10c-b G — the activation preflight's copy of the reviewed cron job must never drift from the
// migration that actually schedules it.
//
// The preflight refuses to arm any job whose stored schedule/command is not the reviewed one. That
// check is only as good as the text it compares against: the moment someone legitimately changes
// the F migration's endpoint or command and does not update the preflight, the preflight starts
// refusing every correct job — or, if the edit went the other way, starts accepting a job nobody
// reviewed. Neither failure announces itself at activation time, when it is far too late.
//
// So the two literals are pinned to each other HERE, in the test suite CI always runs, rather than
// left to a comment asking the next person to remember.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');

const MIGRATION = read('supabase', 'migrations', '20261012100000_notif_10cb_digest_cron_inert.sql');
// N4 round 5 RE-POINTS that command: its body now names the pending invocation, so the request a
// deliberate artifact sends carries the identity it just opened and a tick's carries null. The
// command text is otherwise byte-identical, and THIS migration is now the authoritative source of
// what the schedule runs — the pins below follow it, not the original.
const REPOINT = read('supabase', 'migrations', '20261026100000_notif_n4_dispatch_carries_invocation.sql');
// The assertions live in a shared include, pulled in by BOTH the read-only dry run
// (activation_preflight.sql) and the transactional gate (activate.sql), so the two can never
// diverge into checking different things.
// BOTH shared assertion files: the job-identity block was split out so `assert-inert` can run it
// BEFORE any switch is enabled, and together they are what the gate actually evaluates.
const PREFLIGHT =
  read('scripts', 'rollout', 'notif-10cb', 'sql', '_job_identity_assertions.sql') + '\n' +
  read('scripts', 'rollout', 'notif-10cb', 'sql', '_activation_assertions.sql');
const ACTIVATE = read('scripts', 'rollout', 'notif-10cb', 'sql', 'activate.sql');
const DRY_RUN = read('scripts', 'rollout', 'notif-10cb', 'sql', 'activation_preflight.sql');
const INVOKE = read('scripts', 'rollout', 'notif-10cb', 'sql', 'canary_invoke.sql');
// The disabled smoke runs the SAME stored command through the SAME guards, so it carries the same
// hash pin and belongs in every scan that covers the canary's. It was added later and was missed.
const SMOKE = read('scripts', 'rollout', 'notif-10cb', 'sql', 'smoke_invoke.sql');

/** The same normalisation the preflight applies in SQL: btrim + collapse whitespace runs. */
const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();

/** What the F migration ACTUALLY schedules. */
const reviewed = (() => {
  const m = MIGRATION.match(
    /cron\.schedule\(\s*'notification-digest-worker'\s*,\s*'([^']+)'\s*,\s*\$cmd\$([\s\S]*?)\$cmd\$\s*\)/);
  if (!m) throw new Error('the F migration no longer schedules notification-digest-worker in the expected form');
  const r = REPOINT.match(/v_cmd text := \$cmd\$([\s\S]*?)\$cmd\$;/);
  if (!r) throw new Error('the re-point migration no longer carries a command');
  return { schedule: m[1], command: r[1], installed: m[2] };
})();

/** What the preflight will demand of a live job. */
const expected = (() => {
  const sched = PREFLIGHT.match(/'([^']*\*\/\d+[^']*)'::text,\n\s*'the cron schedule is the reviewed one/);
  const hash = PREFLIGHT.match(/'([0-9a-f]{32})'::text,\n\s*'the cron command is EXACTLY the reviewed command/);
  if (!sched) throw new Error('the preflight no longer pins a cron schedule literal');
  if (!hash) throw new Error('the preflight no longer pins a reviewed-command md5');
  return { schedule: sched[1], commandMd5: hash[1] };
})();

/** Postgres md5() over the same normalised text — the preflight computes exactly this. */
const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

describe('G — activation_preflight is pinned to the reviewed cron job', () => {
  it('demands the schedule the F migration actually installs', () => {
    expect(expected.schedule).toBe(reviewed.schedule);
  });

  // The preflight pins a hash, so this is the ONLY thing standing between a legitimate change to
  // the migration's command and a gate that would then refuse every correctly-installed job.
  it('demands the command the F migration actually installs', () => {
    expect(expected.commandMd5).toBe(md5(normalize(reviewed.command)));
  });

  // The endpoint is the part that decides where a Vault-decrypted service_role bearer is posted,
  // so it is pinned on its own rather than only inside the whole-command comparison.
  it('pins the same worker endpoint in both files', () => {
    const url = /https:\/\/[a-z0-9]+\.supabase\.co\/functions\/v1\/notification-digest-worker/;
    const inMigration = reviewed.command.match(url);
    expect(inMigration, 'the F migration must post to a notification-digest-worker endpoint').not.toBeNull();
    expect(PREFLIGHT).toContain(inMigration![0]);
  });

  it('pins the endpoint to this project, not just any supabase host', () => {
    const config = read('supabase', 'config.toml');
    const projectId = config.match(/^\s*project_id\s*=\s*"([^"]+)"/m)?.[1];
    expect(projectId, 'supabase/config.toml must declare a project_id').toBeTruthy();
    expect(reviewed.command).toContain(`https://${projectId}.supabase.co/functions/v1/notification-digest-worker`);
  });

  // The bearer must be resolved at TICK time. A literal in either file would mean the
  // service_role key is sitting in a checked-in artifact and in cron.job in plaintext.
  it('neither file carries an inline credential', () => {
    const credential = /(eyJ[A-Za-z0-9_-]{10,}|sb_secret_[A-Za-z0-9_-]{5,}|sbp_[A-Za-z0-9_-]{5,})/;
    expect(reviewed.command).not.toMatch(credential);
    // The preflight's own deny-list regex names these prefixes; strip that one line before
    // scanning, or the guard would trip on the guard.
    expect(PREFLIGHT.replace(/^.*command !~ .*$/m, '')).not.toMatch(credential);
    expect(reviewed.command).toContain('vault.decrypted_secrets');
  });

  // The legacy-key scan flags any .sql outside supabase/migrations that contains a POST + auth
  // header + credential read. This artifact must keep passing it on its own merits, not because
  // someone later widened an allow-list.
  it('does not itself look like a key-sending statement', () => {
    const noComments = PREFLIGHT.replace(/--.*$/gm, '');
    const sends = /\bhttp_post\s*\(/i.test(noComments)
      && /authorization|api[-_]?key|bearer/i.test(noComments)
      && /vault\.decrypted_secrets|decrypted_secret|current_setting/.test(noComments);
    expect(sends, 'activation_preflight.sql now matches the key-sender signature').toBe(false);
  });
});

describe('G — the preflight is bound to one named canary run', () => {
  // Every canary assertion must be scoped to :run_id. An unscoped one reads the whole table, which
  // any earlier rollout attempt satisfies permanently — the exact defect this slice closed.
  it('scopes its canary evidence to :run_id rather than the whole table', () => {
    const section = PREFLIGHT.slice(PREFLIGHT.indexOf('-- 5. THE CANARY'));
    for (const table of ['notification_digest_attempts', 'notification_worker_runs',
                         'notification_digest_group_attempts']) {
      const stmts = section.split(/;\s*\n/).filter((s) => s.includes(table));
      expect(stmts.length, `no assertion reads ${table}`).toBeGreaterThan(0);
      for (const s of stmts) {
        expect(s, `an assertion reads ${table} without binding to :run_id:\n${s}`).toContain("run_id'");
      }
    }
  });

  it('requires the canary to be the newest dispatch run and to be recent', () => {
    expect(PREFLIGHT).toContain('in flight, started after, or ended after this canary');
    expect(PREFLIGHT).toMatch(/now\(\) - ended_at <= interval '6 hours'/);
  });

  // `accepted` is written before the mismatch is detected, so the structural check is the only
  // honest evidence that the send correlated. Losing it would make every other canary assertion
  // pass over a permanently mis-correlated message.
  it('checks the attempt and its group agree on the provider message id', () => {
    expect(PREFLIGHT).toContain('a.provider_message_id IS DISTINCT FROM g.provider_message_id');
  });

  // EXACTLY ONE CLOSED ROW, not "no non-closed rows" — the latter passes vacuously when the row is
  // absent, and a real send ensures it exists, so absence means the breaker state was lost.
  it('requires the email circuit row to EXIST and be closed', () => {
    expect(PREFLIGHT).toMatch(/channel = 'email' AND state = 'closed'\)/);
    expect(PREFLIGHT).not.toMatch(/channel = 'email' AND state <> 'closed'/);
  });
});

describe('G — verifying and arming are one transaction', () => {
  // Checking in one statement and arming in another is a time-of-check/time-of-use hole: between
  // them the job can be altered, replaced or unscheduled, and an arm-by-name matching ZERO rows
  // succeeds silently — reporting a cron as ARMED over a job that is no longer there.
  it('both wrappers run the SAME shared assertions', () => {
    expect(ACTIVATE).toContain('\\i _activation_assertions.sql');
    expect(DRY_RUN).toContain('\\i _activation_assertions.sql');
  });

  it('activate.sql locks the job row BEFORE it asserts anything', () => {
    const lock = ACTIVATE.indexOf('FOR UPDATE');
    const assertions = ACTIVATE.indexOf('\\i _activation_assertions.sql');
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(assertions);
  });

  it('activate.sql is a single explicit transaction', () => {
    expect(ACTIVATE).toMatch(/^\s*BEGIN;/m);
    expect(ACTIVATE).toMatch(/^\s*COMMIT;/m);
    expect(ACTIVATE.indexOf('BEGIN;')).toBeLessThan(ACTIVATE.indexOf('FOR UPDATE'));
  });

  // Every lock wait must be bounded. This transaction holds a table lock on the run ledger while it
  // waits for group locks, so an unbounded wait behind a slow webhook — or a deadlock against the
  // orphan reconciler, which holds group locks across its loop — would stall every worker-run write
  // rather than failing an owner-driven step that is always safe to re-run.
  // COMMENTS STRIPPED FIRST. These files explain themselves at length, and every property below is
  // also *described* in prose next to the statement that implements it — so a search over the raw
  // text passes when the statement is commented out. That is the vacuous-assertion trap this slice
  // has hit repeatedly, in a new place.
  const activeSql = ACTIVATE.replace(/--.*$/gm, '');

  it('activate.sql bounds every lock wait before taking any lock', () => {
    const m = activeSql.match(/SET LOCAL lock_timeout\s*=\s*'([^']+)'/);
    expect(m, 'activate.sql must set a lock_timeout').not.toBeNull();
    // PostgreSQL treats 0 as DISABLED — the same footgun assert_timeout_ms guards in the shell
    // library. A zero here removes exactly the bound while every comment still says "bounded".
    expect(m![1]).toMatch(/^[1-9][0-9]*(ms|s|min)?$/);
    const at = activeSql.search(/SET LOCAL lock_timeout/);
    for (const lock of ['LOCK TABLE', 'FOR UPDATE', 'FOR SHARE']) {
      expect(at, `lock_timeout must precede ${lock}`).toBeLessThan(activeSql.indexOf(lock));
    }
  });

  // lock_timeout bounds EACH acquisition; the ordered FOR SHARE can take many group locks, so a
  // succession of blockers that each release in time would still stall activation indefinitely.
  it('activate.sql also caps the total statement time, before every lock', () => {
    const m = activeSql.match(/SET LOCAL statement_timeout\s*=\s*'([^']+)'/);
    expect(m, 'activate.sql must cap the whole statement, not just each lock wait').not.toBeNull();
    expect(m![1]).toMatch(/^[1-9][0-9]*(ms|s|min)?$/);
    // POSITION MATTERS as much as presence. Moved below the group lock it still exists and is still
    // positive, while the statement that actually needs the total bound runs without it.
    const at = activeSql.search(/SET LOCAL statement_timeout/);
    for (const lock of ['LOCK TABLE', 'FOR UPDATE', 'FOR SHARE']) {
      expect(at, `statement_timeout must precede ${lock}`).toBeLessThan(activeSql.indexOf(lock));
    }
  });

  // Two transactions taking overlapping group sets in opposite orders is the classic deadlock.
  it('activate.sql locks the canary groups in a deterministic order', () => {
    const groupLock = activeSql.match(/SELECT g\.id FROM public\.notification_digest_groups[\s\S]*?FOR SHARE;/)?.[0];
    expect(groupLock, 'activate.sql must lock the canary groups').toBeTruthy();
    expect(groupLock!).toMatch(/ORDER BY g\.id\s*\n\s*FOR SHARE;/);
  });

  // The cheap refusal must come BEFORE the group locks, or activation queues behind the very run
  // that is going to invalidate it — while holding the run-ledger lock.
  it('activate.sql refuses an in-flight dispatch run before taking group locks', () => {
    const check = activeSql.indexOf('no dispatch run is in flight');
    expect(check, 'activate.sql must pre-check for an in-flight run').toBeGreaterThan(-1);
    expect(check).toBeLessThan(activeSql.indexOf('FOR SHARE'));
  });

  it('activate.sql arms by jobid and count-checks the arm', () => {
    expect(ACTIVATE).toContain('cron.alter_job(j.jobid, active := true)');
    expect(ACTIVATE).toContain('exactly one job was armed');
  });

  // The dry run must stay a dry run, or "preflight" silently becomes a second way to arm.
  it('the dry run arms nothing', () => {
    expect(DRY_RUN).not.toContain('alter_job');
    expect(DRY_RUN).not.toContain('active := true');
  });
});

// The step that actually sends used to be a hand-written statement in the runbook. It now runs the
// cron job's OWN stored command — which is only safe because the command is hash-pinned to the
// reviewed one. These are the properties no behavioural test can pin: a redundant-but-load-bearing
// guard, and the absence of a transcribed request.
describe('I — canary_invoke executes the reviewed command rather than transcribing it', () => {
  const invokeSql = INVOKE.replace(/--.*$/gm, '');

  // If this file ever spells the request out, two things break at once: what is invoked stops being
  // provably what was reviewed, and a checked-in .sql grows a key-sending statement in a repo whose
  // legacy-key posture depends on that scan staying meaningful.
  it('never writes the request out — it executes what the job stores', () => {
    expect(invokeSql).not.toMatch(/\bhttp_post\s*\(/i);
    expect(invokeSql).not.toMatch(/authorization/i);
    expect(invokeSql).toMatch(/EXECUTE v_cmd/);
  });

  it('does not itself look like a key-sending statement', () => {
    const sends = /\bhttp_post\s*\(/i.test(invokeSql)
      && /authorization|api[-_]?key|bearer/i.test(invokeSql)
      && /vault\.decrypted_secrets|decrypted_secret|current_setting/.test(invokeSql);
    expect(sends, 'canary_invoke.sql now matches the key-sender signature').toBe(false);
  });

  // EVERY hash literal in this directory, not just this file's — the reviewed command's md5 now
  // appears in three artifacts, and a legitimate change to the F migration must fail here rather
  // than leave one of them silently pinned to a command nobody reviewed.
  it('pins every reviewed-command hash in the bundle to the migration', () => {
    const files = { INVOKE, SMOKE, ACTIVATE, PREFLIGHT };
    const wanted = md5(normalize(reviewed.command));
    let found = 0;
    for (const [name, text] of Object.entries(files)) {
      for (const literal of text.replace(/--.*$/gm, '').match(/'[0-9a-f]{32}'/g) ?? []) {
        expect(literal.slice(1, -1), `${name} pins a hash that is not the reviewed command's`).toBe(wanted);
        found++;
      }
    }
    expect(found, 'no reviewed-command hash is pinned anywhere').toBeGreaterThanOrEqual(4);
  });

  // SUBSUMED, AND SAID SO. Under the row lock the command cannot change between the shared
  // assertions and the EXECUTE, so deleting this re-check leaves every behavioural test green. It is
  // kept because losing the include would otherwise turn EXECUTE into "run whatever is in cron.job",
  // and it is pinned here because that is the only place it can be.
  // BOTH invokers, not just the canary's. The smoke's copy said it was "pinned structurally" while
  // nothing scanned it — deleting it was behaviourally subsumed AND structurally undetected.
  it.each([['canary_invoke.sql', INVOKE], ['smoke_invoke.sql', SMOKE]])(
    '%s re-checks the hash in the same statement that reads the text it executes', (_name, text) => {
    const block = text.replace(/--.*$/gm, '').match(/DO \$do\$[\s\S]*?\$do\$;/)?.[0];
    expect(block, 'the artifact must execute inside a DO block').toBeTruthy();
    expect(block!).toMatch(/md5\(btrim\(regexp_replace\(v_cmd/);
    expect(block!.indexOf('md5(')).toBeLessThan(block!.indexOf('EXECUTE v_cmd'));
  });

  // A failed invoke must be distinguishable from a rolled-back one, or a retry sends twice.
  it.each([['canary_invoke.sql', INVOKE], ['smoke_invoke.sql', SMOKE]])(
    '%s prints a provisional request id INSIDE the transaction', (_name, text) => {
    const sql = text.replace(/--.*$/gm, '');
    const prov = sql.indexOf('CANARY_REQUEST_PROVISIONAL');
    const commit = sql.search(/^\s*COMMIT;/m);
    expect(prov, 'no provisional marker').toBeGreaterThan(-1);
    expect(prov, 'the provisional marker must be emitted before COMMIT').toBeLessThan(commit);
    expect(sql.indexOf('CANARY_REQUEST_ID='), 'the final marker must come after COMMIT').toBeGreaterThan(commit);
  });

  it('runs the shared job-identity gate — the same one assert-inert and activate use', () => {
    expect(INVOKE).toContain('\\i _job_identity_assertions.sql');
    const lock = INVOKE.indexOf('FOR UPDATE');
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(INVOKE.indexOf('\\i _job_identity_assertions.sql'));
  });

  it('is one explicit transaction with every lock wait bounded before any lock', () => {
    expect(invokeSql).toMatch(/^\s*BEGIN;/m);
    expect(invokeSql).toMatch(/^\s*COMMIT;/m);
    for (const setting of ['lock_timeout', 'statement_timeout']) {
      const m = invokeSql.match(new RegExp(`SET LOCAL ${setting}\\s*=\\s*'([^']+)'`));
      expect(m, `canary_invoke.sql must set a ${setting}`).not.toBeNull();
      // PostgreSQL reads 0 as DISABLED, so presence is not enough.
      expect(m![1]).toMatch(/^[1-9][0-9]*(ms|s|min)?$/);
      const at = invokeSql.search(new RegExp(`SET LOCAL ${setting}`));
      for (const lock of ['LOCK TABLE', 'FOR UPDATE']) {
        expect(at, `${setting} must precede ${lock}`).toBeLessThan(invokeSql.indexOf(lock));
      }
    }
  });

  it('arms nothing — invoking and arming are different owner decisions', () => {
    expect(INVOKE).not.toContain('alter_job');
    expect(INVOKE).not.toContain('active := true');
  });

  // THE MOST LOAD-BEARING LINE IN THE FILE, and the one whose absence is silent. `EXECUTE` runs
  // catalog text under the session search_path, and naming pg_catalog first is NOT protection:
  // function resolution prefers an exact-arity overload over pg_catalog's VARIADIC "any" wherever
  // that schema sits in the path. Only excluding hostile schemas works.
  it('pins search_path before it asserts or executes anything', () => {
    const at = invokeSql.search(/SET search_path = pg_catalog;/);
    expect(at, 'canary_invoke.sql must pin search_path').toBeGreaterThan(-1);
    expect(at).toBeLessThan(invokeSql.indexOf('EXECUTE v_cmd'));
    expect(at).toBeLessThan(invokeSql.indexOf('LOCK TABLE'));
  });
});

// The command a cron TICK runs has nothing that can be placed in front of it, so it has to be safe
// on its own under any search_path.
describe('I — the scheduled command survives a hostile search_path unaided', () => {
  // WHERE THE REAL PROOF LIVES: verify/preflight-pg.mjs compares this command's STORED PARSE TREE
  // (pg_rewrite.ev_action, which carries the OIDs the planner bound) under an empty search_path
  // against the same tree built with a hostile schema first, and separately proves the detector
  // fires by removing each qualification one at a time. The deparse was tried first and rejected:
  // PostgreSQL renders IS DISTINCT FROM and CASE x WHEN y as syntax, so pg_get_viewdef reads
  // identically even when the underlying operator has been redirected.
  //
  // THIS FILE DELIBERATELY NO LONGER TRIES TO DECIDE THE QUESTION BY REGEX. It did, for two rounds,
  // and each round found another construct it had missed: first the `=` selecting the Vault row,
  // then LIKE (`~~`), IN, BETWEEN, CAST(x AS t) and typed literals. A regex over SQL is a partial
  // parser, and this slice has already paid once for keeping one. What is left here is the cheap
  // statement of intent — a specific failure message when a specific protection is dropped — and it
  // is labelled best-effort rather than left looking exhaustive.
  it('names the qualified forms it is meant to have (best-effort; the proof is in preflight-pg.mjs)', () => {
    expect(reviewed.command).toContain('pg_catalog.jsonb_build_object');
    expect(reviewed.command).toContain('OPERATOR(pg_catalog.||)');
    // TWO comparisons now — the Vault name and the invocation's status. A planted text = text
    // answering false on the second would send a body naming no invocation, silently restoring
    // the "search for the one unresolved invocation" ambiguity round 5 removed.
    expect(reviewed.command.match(/OPERATOR\(pg_catalog\.=\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(reviewed.command).toContain('public.notification_worker_invocations');
    expect(reviewed.command).toContain("'invocation_id'");
  });

  // The re-point is a BODY change and nothing else: same endpoint, same Vault bearer, same
  // qualification — so the canary still executes what the schedule will execute, and the md5 pin
  // still means what it meant.
  it('re-points ONLY the body of the command the F migration installs', () => {
    const withoutBody = (c: string) => normalize(c).replace(/body :=.*?\) AS request_id;/s, 'body := <B>) AS request_id;');
    expect(withoutBody(reviewed.command)).toBe(withoutBody(reviewed.installed));
    expect(normalize(reviewed.installed)).toContain("body := '{}'::pg_catalog.jsonb");
    expect(normalize(reviewed.command)).not.toContain("body := '{}'::pg_catalog.jsonb");
  });

  it('still resolves the bearer from Vault, and posts to this project', () => {
    expect(reviewed.command).toContain('vault.decrypted_secrets');
    expect(reviewed.command).toContain('net.http_post');
  });

  // ...and the exhaustive check must actually be wired in, or the pointer above is a comment.
  it('the exhaustive resolution proof is wired into the rollout suite', () => {
    const harness = read('scripts', 'rollout', 'notif-10cb', 'verify', 'preflight-pg.mjs');
    expect(harness).toContain('binds IDENTICALLY under a hostile search_path');
    expect(harness).toContain('has an exact-signature rival planted');
    // Every FIELD in the tree must be classified, so a node type carrying a new OID fails by name
    // rather than going uncovered.
    expect(harness).toContain('is classified as OID-bearing or inert');
    // A VARIADIC signature cannot be duplicated, so coverage for one depends on an exact-arity rival
    // really existing. That check is unpinnable behaviourally — this command's only variadic HAS a
    // rival, so removing it changes nothing today — and it only matters for a command not yet
    // written. Pinned here instead of left looking tested.
    expect(harness, 'variadic coverage must be conditional on a rival actually existing')
      .toMatch(/nspname = 'shadow'[\s\S]{0,200}?if \(rival\.length\)/);
    // The per-qualification positive control is what actually settles coverage: it removes each
    // qualification the command carries and requires the tree to move.
    expect(harness).toContain('the detector FIRES on every qualification the command carries');
    // `mergeTargetRelation` is a rangetable INDEX, like resultRelation — the target's OID lives on
    // the RTE. It is zero in this SELECT-only command, so no behavioural test can see the
    // misclassification; pinned here instead of left to be re-introduced.
    expect(harness, 'mergeTargetRelation is an index, not a relation OID')
      .not.toMatch(/mergeTargetRelation: \['pg_class'/);
    expect(harness).toMatch(/'mergeTargetRelation', 'name'/);
    // ...and it must be the PARSE TREE it compares, not the deparse: pg_get_viewdef renders
    // IS DISTINCT FROM and CASE x WHEN y as syntax, so it reads identically even when the
    // underlying operator has been redirected.
    expect(harness).toContain('ev_action');
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['verify:rollout']).toContain('notif-10cb/verify/preflight-pg.mjs');
  });
});

// The artifacts have the same exposure and no qualification of their own: `_job_identity_assertions`
// alone calls count, md5, btrim, regexp_replace, regexp_matches and current_setting unqualified, and
// a hostile `md5(text)` would match any command at all. One mechanism, applied to every file.
describe('I — every rollout artifact pins name resolution before it does anything', () => {
  const dir = join(process.cwd(), 'scripts', 'rollout', 'notif-10cb', 'sql');
  const artifacts = readdirSync(dir).filter((f) => f.endsWith('.sql') && !f.startsWith('_'));

  it('finds the artifacts to check', () => {
    expect(artifacts.length).toBeGreaterThanOrEqual(10);
  });

  // THE FIRST EXECUTABLE THING, established exactly rather than by a list of statement keywords.
  // The previous version recognised seven starters, so a DO / CALL / INSERT / ALTER / SET ROLE — or
  // an indented statement — before the pin would have passed as long as a recognised keyword turned
  // up later. Strip what genuinely executes nothing (comments, blank lines, and the psql
  // meta-commands that only configure the client) and whatever is left FIRST must be the pin.
  //
  // ALLOW-LISTED EXACTLY, not by category. Treating every `\set` as inert was wrong three ways:
  // `\set ON_ERROR_STOP off` changes what a failed assertion does, `\set run_id …` overrides a value
  // the dispatcher validated, and psql executes BACKQUOTES inside a meta-command argument as a shell
  // command. So the only thing permitted before the pin is the one preamble line these files
  // actually use, matched literally.
  const INERT_PREAMBLE = /^\\set ON_ERROR_STOP on$/;
  //
  // A `\`-LINE IS JUDGED RAW, and that distinction is the whole finding. Inside a psql meta-command
  // `--` is an ordinary argument, not an SQL comment — so `\set ON_ERROR_STOP on -- ` + a backquoted
  // shell command looked like the exact permitted preamble once comments were stripped, while psql
  // ran the shell command before the path was ever pinned. Only whole SQL lines get their comments
  // stripped; a meta-command has to match in full.
  const executableLines = (text: string) => text
    .split('\n')
    .map((l) => l.trim())
    .map((l) => (l.startsWith('\\') ? l : l.replace(/--.*$/, '').trim()))
    .filter((l) => l !== '' && !l.startsWith('--'));
  const firstExecutable = (text: string) =>
    executableLines(text).filter((l) => !INERT_PREAMBLE.test(l))[0] ?? '';

  it.each(artifacts)('%s runs no shell before it pins the path', (file) => {
    // psql expands backquotes in a meta-command ARGUMENT by running a shell. Judged on the raw
    // meta-command lines for the reason above; SQL lines have their comments stripped first, because
    // these files quote SQL names in prose constantly and that is not an expansion.
    const before = executableLines(readFileSync(join(dir, file), 'utf8'));
    const pin = before.indexOf('SET search_path = pg_catalog;');
    expect(pin, `${file} does not pin search_path`).toBeGreaterThan(-1);
    for (const line of before.slice(0, pin)) {
      expect(line, `${file} runs a shell command before the pin: ${line}`).not.toMatch(/`/);
    }
  });

  it.each(artifacts)('%s pins search_path first, session-wide', (file) => {
    const text = readFileSync(join(dir, file), 'utf8');
    expect(firstExecutable(text), `${file} runs something before it pins search_path`)
      .toBe('SET search_path = pg_catalog;');
    // SESSION-WIDE, not SET LOCAL: COMMIT reverts a local setting, and these files keep asserting
    // and printing afterwards — canary_invoke.sql builds its request-id marker after COMMIT.
    expect(text, `${file} pins the path only for a transaction`).not.toMatch(/SET LOCAL search_path/);
  });

  // The `_`-prefixed files are includes and inherit the includer's session setting. Proving that
  // each has AT LEAST ONE pinned includer is not enough — an unpinned one elsewhere is exactly the
  // hole. So this scans every .sql under scripts/rollout for include sites and checks them all.
  it('every include site in the repo pins the path first', () => {
    const roots = [join(process.cwd(), 'scripts', 'rollout')];
    const sqlFiles: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.sql')) sqlFiles.push(full);
      }
    };
    roots.forEach(walk);

    const includes = readdirSync(dir).filter((f) => f.startsWith('_'));
    const offenders: string[] = [];
    const chained = new Set<string>();
    let sites = 0;
    for (const f of sqlFiles) {
      const text = readFileSync(f, 'utf8');
      for (const inc of includes) {
        if (!new RegExp(`^\\\\ir? .*${inc.replace('.', '\\.')}\\s*$`, 'm').test(text)) continue;
        sites++;
        // A `_`-file including another `_`-file is fine: it is itself an include, so it inherits the
        // session setting of whatever pulled IT in — and this same scan covers that includer. Every
        // other include site has to pin, wherever in the tree it lives.
        const isShared = f.startsWith(dir) && f.slice(dir.length + 1).startsWith('_');
        if (!isShared && firstExecutable(text) !== 'SET search_path = pg_catalog;') {
          offenders.push(`${f} includes ${inc}`);
        }
        if (isShared) chained.add(f.slice(dir.length + 1));
      }
    }
    expect(sites, 'no include sites found — this check would be vacuous').toBeGreaterThan(0);
    expect(offenders, 'a shared include is reached from a file that does not pin the path').toEqual([]);
    // ...and an include that nothing pulls in is dead weight whose protection nobody is checking.
    for (const inc of includes) {
      const pulled = sqlFiles.some((f) =>
        new RegExp(`^\\\\ir? .*${inc.replace('.', '\\.')}\\s*$`, 'm').test(readFileSync(f, 'utf8')));
      expect(pulled, `${inc} is included by nothing`).toBe(true);
    }
    // ROOTED, not tautological. The previous version asserted that a shared file that includes
    // another shared file is itself a shared file — which is true by construction and permits an
    // include CYCLE with no pinned root at all. This walks the graph from the pinning artifacts and
    // requires every shared include to be reachable from one.
    const reachable = new Set<string>();
    const visit = (file: string) => {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/^\\ir? +(\S+\.sql)\s*$/gm)) {
        // RESOLVED AS A PATH, not reduced to a basename in this directory. The 10c-a3 assertion
        // helper is included as `../../notif-10ca3/sql/_assert.sql` from every artifact here, and
        // limiting the graph to local `_` files left it — and anything IT includes, or any path
        // reset it might add — outside a check that claimed to be rooted.
        const target = resolve(dirname(file), m[1]);
        if (reachable.has(target) || !existsSync(target)) continue;
        reachable.add(target);
        visit(target);
      }
    };
    artifacts.forEach((a) => visit(join(dir, a)));
    for (const inc of includes) {
      expect(reachable.has(join(dir, inc)), `${inc} is not reachable from any path-pinning artifact`).toBe(true);
    }
    expect([...chained].every((c) => reachable.has(join(dir, c)))).toBe(true);
    // ...and nothing reached from a pinned artifact may UNDO the pin. The 10c-a3 helper sits inside
    // that graph, so a `SET search_path` added there would silently unpin every artifact here.
    // NOTHING REACHABLE MAY UNDO THE PIN, and "no second SET" is not the same rule. `RESET
    // search_path`, `RESET ALL`, `set_config('search_path', …)` and `\connect` all put the path back
    // to the role/database default without ever writing SET. The ROOT ARTIFACTS are scanned too —
    // the previous version checked only the files they include, so an artifact could have undone its
    // own pin two lines later.
    // BEST-EFFORT, AND SAID SO. This is a text scan, which is a partial parser — `DISCARD ALL`,
    // a computed `set_config($$search_path$$, …)`, or SQL emitted through `\gexec` are all ways past
    // it. The AUTHORITY is behavioural: verify/preflight-pg.mjs runs six artifacts under two hostile
    // paths with eight shadowed names planted, and an artifact that unpinned itself mid-file would
    // reach one of them. This list catches the plausible edit early, with a message naming the rule.
    const undoes = [
      /^\s*SET\s+(LOCAL\s+)?search_path/mi,
      /^\s*RESET\s+(search_path|ALL)\b/mi,
      /^\s*DISCARD\s+(ALL|PLANS|SEQUENCES|TEMP|TEMPORARY)\b/mi,
      /set_config\s*\(\s*('search_path'|\$\$search_path\$\$)/i,
      /^\s*\\c(onnect)?\b/mi,
      /^\s*\\gexec\b/mi,
    ];
    for (const f of [...reachable, ...artifacts.map((a) => join(dir, a))]) {
      const raw = readFileSync(f, 'utf8');
      const body = raw.split('\n')
        .map((l) => (l.trim().startsWith('\\') ? l : l.replace(/--.*$/, ''))).join('\n');
      const afterPin = body.split('SET search_path = pg_catalog;').slice(1).join('\n');
      for (const re of undoes) {
        expect(afterPin, `${f} undoes the path pin (${re}) — every artifact that includes it is unpinned`)
          .not.toMatch(re);
      }
      // ...and an INCLUDED file may not pin or reset it at all: it inherits, and touching the setting
      // would change it for the artifact that pulled it in.
      if (!artifacts.some((a) => join(dir, a) === f)) {
        for (const re of undoes) {
          expect(body, `${f} is an include and must not touch search_path (${re})`).not.toMatch(re);
        }
      }
    }
  });
});

describe('I — canary_scope_verify measures what the canary reached', () => {
  const SCOPE = read('scripts', 'rollout', 'notif-10cb', 'sql', 'canary_scope_verify.sql');
  const scopeSql = SCOPE.replace(/--.*$/gm, '');

  // RECIPIENTS, not groups: a split produces several chunk groups for one recipient, and counting
  // groups would refuse a good canary — a gate that gets switched off rather than heeded.
  it('counts distinct recipients, not groups or attempts', () => {
    expect(scopeSql).toMatch(/count\(DISTINCT g\.recipient_key\)/);
  });

  // Both routes into a group: worker_run_id is stamped at lease and can be overwritten by a later
  // run, and an attempt row survives that.
  it('finds the run\'s groups by BOTH the lease stamp and its attempts', () => {
    expect(scopeSql).toMatch(/g\.worker_run_id = :'run_id'/);
    expect(scopeSql).toMatch(/a\.worker_run_id = :'run_id'/);
  });

  it('is read-only — it reports on a send that already happened', () => {
    expect(scopeSql).not.toMatch(/\b(UPDATE|DELETE|INSERT)\s+(?!INTO pg_temp)/);
    expect(scopeSql).not.toContain('alter_job');
  });
});

// The pre-invocation ceiling and the post-invocation measure are two halves of one claim, so the
// predicates the ceiling reads are pinned to the schema that owns them.
describe('I — the pre-invocation ceiling reads the schema\'s own predicates', () => {
  const invokeSql = INVOKE.replace(/--.*$/gm, '');
  const foundationSql = read('supabase', 'migrations',
    '20261002100000_notification_digest_schema_foundation.sql');

  // `terminal_at IS NULL` is exactly "not terminal" because the guard trigger owns that column — a
  // copied state-name list would drift the first time a state is added, and drift in this direction
  // means a canary that reaches a population.
  it('bounds the blast radius on the schema-owned terminal clock, not a copied state list', () => {
    expect(foundationSql).toContain('NEW.terminal_at := now();');
    expect(foundationSql).toMatch(/ELSE\s*\n\s*NEW\.terminal_at := NULL;/);
    expect(invokeSql).toContain('terminal_at IS NULL');
    expect(invokeSql, 'a copied terminal-state list would drift from the schema')
      .not.toContain("'failed_terminal'");
  });

  // ...and the forming half must stay the same predicate the schema indexes for, or the bound counts
  // rows the worker will not act on — or worse, misses rows it will.
  it('counts forming digest work with the migration\'s own predicate', () => {
    const idx = foundationSql.match(
      /CREATE INDEX IF NOT EXISTS idx_outbox_digest_forming[\s\S]*?WHERE ([^;]+);/)?.[1];
    expect(idx, 'the digest-forming index must still exist to pin against').toBeTruthy();
    for (const clause of idx!.split(' AND ').map((s) => s.trim())) {
      expect(invokeSql, `the blast-radius bound no longer matches the forming predicate: ${clause}`)
        .toContain(clause);
    }
  });

  // The ceiling is a snapshot; the post-invocation measure is what makes the claim true after the
  // fact. Neither file may quietly stop saying so.
  it('says what the ceiling does NOT bound, and points at the check that does', () => {
    expect(INVOKE).toContain('canary_scope_verify.sql');
    expect(INVOKE).toMatch(/WHAT IT DOES NOT BOUND/);
  });
});

describe('G — the dispatcher can only reach psql through the sanitising wrapper', () => {
  const SCRIPT = read('scripts', 'rollout', 'notif-10cb', 'run-enablement.sh');

  // A single bare `psql` reintroduces the whole PGHOSTADDR/PGSERVICE hole for that one call, and
  // it is exactly the kind of thing a later edit adds without noticing.
  it('never invokes bare psql', () => {
    const bare = SCRIPT.split('\n')
      .map((l, i) => [i + 1, l] as const)
      // Comments are stripped, whole-line and trailing alike — this file documents `psql` in
      // prose next to the code that calls it, and a prose mention is not an invocation.
      .map(([n, l]) => [n, l.replace(/^\s*#.*$/, '').replace(/\s#.*$/, '')] as const)
      .filter(([, l]) => /(^|[^_a-zA-Z])psql\s/.test(l) && !/psql_safe/.test(l));
    expect(bare.map(([n, l]) => `${n}: ${l.trim()}`)).toEqual([]);
  });

  it('runs the environment guard before dispatching any subcommand', () => {
    const guard = SCRIPT.indexOf('assert_no_hostile_libpq_env\n');
    const dispatch = SCRIPT.indexOf('case "$SUB" in');
    expect(guard, 'the guard must be called').toBeGreaterThan(-1);
    expect(guard).toBeLessThan(dispatch);
  });
});


describe('N4 M1 part 3 — the invocation gate reaches every deliberate artifact', () => {
  const SQL = (f: string) =>
    readFileSync(resolve(__dirname, '..', '..', 'scripts', 'rollout', 'notif-10cb', 'sql', f), 'utf8');

  it('the N4 SEAM corrections: both gates take M1s open lock, and activation refuses under a kill', () => {
    // a snapshot SELECT could not see a manual invoker holding the open lock with an
    // UNCOMMITTED pending row — activation armed the cron and the invocation then dispatched
    for (const f of ['_invocation_gate.sql', '_invocation_gate_replay.sql']) {
      expect(SQL(f)).toContain("hashtextextended('notif-worker-invocation-open', 0)");
    }
    // arming behind an active kill hands the send decision to whoever deletes the kill row
    const asserts = SQL('_activation_assertions.sql');
    expect(asserts).toContain('notification_channel_kill_switches');
    expect(asserts).toContain("'notif-channel-kill:'");
  });

  it('ROUND 2: the replay gate acquires those locks in open()s ORDER — request first, then open', () => {
    // the round-1 correction introduced an ABBA inversion against open() itself. Pin the ORDER,
    // not merely the presence: a concurrent direct open() on the same id deadlocked mid-rollout.
    const replay = SQL('_invocation_gate_replay.sql');
    const reqIdx = replay.indexOf("'notif-worker-invocation-req:'");
    const openIdx = replay.indexOf("hashtextextended('notif-worker-invocation-open', 0)");
    expect(reqIdx).toBeGreaterThan(0);
    expect(openIdx).toBeGreaterThan(reqIdx);
    // …and that IS open()'s order — read from the function, never assumed
    const fn = readFileSync(resolve(__dirname, '..', '..', 'supabase', 'migrations',
      '20261016100000_notif_n4_worker_invocations.sql'), 'utf8')
      .match(/CREATE OR REPLACE FUNCTION public\.open_notification_worker_invocation\([\s\S]*?\n\$\$;/)?.[0];
    expect(fn).toBeTruthy();
    expect(fn!.indexOf("'notif-worker-invocation-req:'"))
      .toBeLessThan(fn!.indexOf("hashtextextended('notif-worker-invocation-open', 0)"));
    // a missing request id must REFUSE: hashing NULL yields NULL and pg_advisory_xact_lock(NULL)
    // takes no lock at all, which would silently restore the visibility race the lock closes
    expect(replay).toContain('requires --invocation-request-id');
  });

  it('BOTH gates exist: strict refuses any unresolved row; replay-aware passes only the exact own request', () => {
    const strict = SQL('_invocation_gate.sql');
    expect(strict).toContain("status IN ('pending', 'started')");
    // the refusal must carry the row's identity — the request_id is the operator's recovery
    // handle (--invocation-request-id), so a bare count assertion would strand them
    expect(strict).toContain('RAISE EXCEPTION');
    expect(strict).toContain('--invocation-request-id=%s');
    const replay = SQL('_invocation_gate_replay.sql');
    expect(replay).toContain("status IN ('pending', 'started')");
    // the ONE difference: a row whose request_id equals the supplied retry falls through to the
    // idempotent open() (which itself refuses a purpose/source mismatch) — everything else refuses
    expect(replay).toContain('IS DISTINCT FROM v_req');
    expect(replay).toContain("set_config('notif.gate_request_id', :'invocation_request_id', true)");
  });

  it.each(['smoke_invoke.sql', 'canary_invoke.sql'])('%s replay-gates, OPENS, and RECORDS its pg_net request — all inside its transaction', (f) => {
    const src = SQL(f);
    const gateIdx = src.indexOf('\\i _invocation_gate_replay.sql');
    const openIdx = src.indexOf('open_notification_worker_invocation(');
    const recordIdx = src.indexOf('record_invocation_net_request(');
    expect(gateIdx).toBeGreaterThan(0);
    expect(openIdx).toBeGreaterThan(gateIdx);
    // open AND the causal dispatch-evidence recording ride INSIDE the artifact transaction —
    // the record exists from the instant the request can, and names the exact request it queued
    const commitIdx = src.lastIndexOf('COMMIT');
    expect(openIdx).toBeLessThan(commitIdx);
    expect(recordIdx).toBeGreaterThan(openIdx);
    expect(recordIdx).toBeLessThan(commitIdx);
    expect(src).toContain(":'invocation_request_id'");
    // and never the strict gate, which would make the advertised replay impossible
    expect(src).not.toContain('\\i _invocation_gate.sql');
  });

  it('activate keeps the STRICT gate and opens nothing — arming never rides over ANY unresolved invocation, its own included', () => {
    const src = SQL('activate.sql');
    expect(src).toContain('\\i _invocation_gate.sql');
    expect(src).not.toContain('_invocation_gate_replay');
    expect(src).not.toContain('open_notification_worker_invocation(');
  });

  it('canary_reconcile resolves STRICTLY: exact run id, one row or raise, quiet only when already resolved', () => {
    const src = SQL('canary_reconcile.sql');
    // the strict RPC — never the bare status-filtered UPDATE whose zero-match sailed through
    expect(src).toContain("resolve_invocation_for_canary_run(:'run_id'");
    expect(src).toContain('CANARY_INVOCATION_RESOLVED=');
    expect(src).not.toMatch(/status = 'started'/);
  });

  it('the migration demands the EXACT disabled body as jsonb — a field probe would pass decorated failures', () => {
    const mig = readFileSync(resolve(__dirname, '..', '..', 'supabase', 'migrations', '20261016110000_notif_n4_invocation_claim.sql'), 'utf8');
    expect(mig).toContain(`IS DISTINCT FROM '{"status":"disabled","reason":"disabled"}'::jsonb`);
    // and completion is causally bound to the recorded dispatch request
    expect(mig).toContain('v.net_request_id <> p_net_request_id');
    // and canary reconciliation requires canary PROVENANCE — a smoke that accidentally sent can
    // never be reconciled as the reviewed canary
    expect(mig).toContain(`v_purpose <> 'canary' OR v_source <> 'canary_invoke.sql'`);
    // classification is LOCKED (a concurrent abandon must never read as reconciled)…
    expect(mig).toMatch(/INTO v_status, v_purpose, v_source, v_net[\s\S]{0,200}FOR UPDATE/);
    // …and one run evidences at most one invocation, schema-level
    const core = readFileSync(resolve(__dirname, '..', '..', 'supabase', 'migrations', '20261016100000_notif_n4_worker_invocations.sql'), 'utf8');
    expect(core).toContain('uq_notification_worker_invocation_run');
    expect(core).toContain('(worker_run_id)\n  WHERE worker_run_id IS NOT NULL');
  });

  it('activation asserts canary provenance INDEPENDENTLY — never trusting that reconcile ran correctly', () => {
    const src = SQL('_activation_assertions.sql');
    const sect = src.match(/-- 8\. THE CANARY'S PROVENANCE[\s\S]*$/)?.[0] ?? '';
    expect(sect).toContain("status = 'completed'");
    expect(sect).toContain("purpose = 'canary'");
    expect(sect).toContain("source = 'canary_invoke.sql'");
    expect(sect).toContain('net_request_id IS NOT NULL');
    expect(sect).toContain("worker_run_id = :'run_id'");
    expect(sect).toContain('1,');   // exactly one — not "at least"
  });

  it('smoke_resolve_disabled closes the disabled smoke by request id, with the pg_net evidence', () => {
    const src = SQL('smoke_resolve_disabled.sql');
    expect(src).toContain('resolve_smoke_invocation_disabled(');
    expect(src).toContain(":'invocation_request_id'");
    expect(src).toContain(":'net_request_id'");
    expect(src).toContain('SMOKE_INVOCATION_RESOLVED=');
    expect(src).toContain('SET search_path = pg_catalog;');
  });

  it('the shell allowlists the ids, prints the request id BEFORE the invoke, and accepts recovery', () => {
    const sh = readFileSync(resolve(__dirname, '..', '..', 'scripts', 'rollout', 'notif-10cb', 'run-enablement.sh'), 'utf8');
    expect(sh).toContain('ARTIFACT_VARS="run_id max_recipients request_id invocation_request_id net_request_id"');
    // ONE uuid mint, inside the shared prepare helper — a per-execution uuid at each call site is
    // exactly what could not recover an ambiguously-committed open
    expect(sh.match(/uuidgen/g)?.length).toBe(1);
    expect(sh).toContain('--invocation-request-id=*)');
    expect(sh.match(/prepare_invocation_request_id "/g)?.length).toBe(2);
    // the smoke CLOSES its invocation after the verdicts
    expect(sh).toContain('smoke_resolve_disabled.sql');
  });
});
