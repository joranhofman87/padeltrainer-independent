import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * N6 — THE RELEASE UNIT IS INERT, proven rather than asserted in a commit message.
 *
 * Deploying this branch must change nothing that sends. That claim is made in
 * `docs/NOTIFICATION_OPERATIONS.md` §8 and in every PR description, and it is exactly the kind of
 * claim that quietly stops being true: one migration that flips an engine flag "just for the
 * cutover event", one schedule without its `active := false`, one seed that opens a delivery path.
 *
 * So the whole notification migration chain is read here, and each way a migration could start a
 * send is checked. This is a TEXT scan on purpose — it runs in milliseconds on every commit and it
 * covers migrations no executing harness applies. The executing proofs live elsewhere:
 * `notifDigestCronInert.realpg`, the rollout preflight harness, and `assert_inert.sql` itself.
 */

const ROOT = resolve(__dirname, '..', '..');
const MIG_DIR = resolve(ROOT, 'supabase', 'migrations');
const files = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
const read = (f: string) => readFileSync(resolve(MIG_DIR, f), 'utf8');
/** the notification chain: every migration that touches the pipeline's own objects */
// the v2 pipeline's own chain: migrations that touch ITS objects. Deliberately not "any file
// mentioning notifications" — older features (the rebook-open cron, the legacy queue) are live by
// design, and sweeping them in here would make this pin fail for someone else's working feature.
// …identified by the OBJECTS they touch, never by their filename: `notify_rebook_member_open`
// matches /notif/ and is a different feature's live cron, and a scope that swept it in would fail
// this pin for someone else's working code.
const PIPELINE_OBJECT = /notification_(outbox|digest|contacts|event_types|activation_boundaries|worker_|provider_|admin_|manage_|preferences_v2|orphan_)/;
const NOTIF = files.filter((f) => PIPELINE_OBJECT.test(read(f)));

/** source lines with comments stripped — a claim in prose is not a behaviour */
const codeLines = (sql: string) =>
  sql.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('--'));

/**
 * What the migration executes AT INSTALL.
 *
 * A dollar-quoted block is NOT automatically deferred — that was the first version of this scan
 * and it was wrong in the one way that matters: `DO $$ ... $$` RUNS while the migration is being
 * applied, so erasing every dollar-quoted region would have hidden exactly the statement this
 * test exists to catch. Only two kinds are deferred, and each is recognised by what precedes it:
 *
 *   * a CREATE FUNCTION / PROCEDURE body — it says what will run later, under its own gates;
 *   * a cron command literal — it says what the SCHEDULER will run, and whether that ever happens
 *     is the job's `active` state, which is checked separately.
 *
 * Everything else — DO blocks, EXECUTE strings, plain statements — is install-time behaviour and
 * is scanned. String literals are kept for the same reason: `EXECUTE 'SELECT net.http_post(...)'`
 * is a send. Only a COMMENT ON statement's text is dropped, because a docstring that describes
 * the pipeline is not the pipeline.
 */
function installStatements(sql: string): string[] {
  const deferred: [number, number][] = [];
  const closers = new Set<number>();      // closing tags of blocks we KEPT — never re-open them
  const tag = /\$([a-z_]*)\$/gi;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(sql))) {
    if (closers.has(m.index)) continue;   // this is the end of a kept block, not a new one
    const close = sql.indexOf(m[0], m.index + m[0].length);
    if (close < 0) break;
    const before = sql.slice(Math.max(0, m.index - 400), m.index);
    // a cron COMMAND: either the literal is syntactically an argument of the schedule/alter call,
    // or it is assigned to a variable this file hands to one — but in the second case ONLY if that
    // variable is never EXECUTEd. "It is later scheduled" does not prove the block did not also
    // run it during installation, which is exactly how a send could hide:
    //   cmd := format($cmd$SELECT net.http_post(…)$cmd$);  EXECUTE cmd;  PERFORM cron.schedule(…, cmd);
    const assignedTo = before.match(/(\w+)\s*(?:text\s*)?:=\s*(?:format\s*\(\s*)?$/i)?.[1];
    const scheduledLater = !!assignedTo
      && new RegExp(`cron\\.(schedule|alter_job)\\s*\\([^;]*\\b${assignedTo}\\b`, 'i').test(sql);
    const executedHere = !!assignedTo && new RegExp(`\\bEXECUTE\\s+${assignedTo}\\b`, 'i').test(sql);
    const isCronCommand = /cron\.(schedule|alter_job)\s*\([^;]*$/i.test(before)
      || (scheduledLater && !executedHere);
    const isFunctionBody = /CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE)\b[\s\S]*\bAS\s*$/i.test(before);
    if (isFunctionBody || isCronCommand) {
      deferred.push([m.index, close + m[0].length]);
      tag.lastIndex = close + m[0].length;        // its contents are deferred; skip them whole
    } else {
      // KEPT — a DO block runs at install, so keep scanning INSIDE it: the digest cron's command
      // literal lives inside one, and a naive skip-to-close would leave that literal in the scan
      // (and, worse, could pair the block's closing tag with the next block's opening one).
      closers.add(close);
      tag.lastIndex = m.index + m[0].length;
    }
  }
  let out = '';
  let cursor = 0;
  for (const [from, to] of deferred.sort((a, b) => a[0] - b[0])) {
    if (from < cursor) continue;
    out += sql.slice(cursor, from) + ' <deferred-body> ';
    cursor = to;
  }
  out += sql.slice(cursor);
  // a COMMENT ON statement's text is documentation, not behaviour
  out = out.replace(/COMMENT ON [\s\S]*?;\s*\n/gi, ' <comment> \n');
  return codeLines(out);
}

describe('the notification release unit is INERT', () => {
  it('scans a chain that actually contains the pipeline (the scan itself is not vacuous)', () => {
    expect(NOTIF.length).toBeGreaterThan(20);
    for (const must of ['20261012100000_notif_10cb_digest_cron_inert.sql',
                        '20261028100000_notif_n5_activation_boundary.sql']) {
      expect(NOTIF).toContain(must);
    }
  });

  it('no migration enables a digest engine — the flag is the rollout artifact’s to flip', () => {
    for (const f of NOTIF) {
      for (const line of codeLines(read(f))) {   // bodies included: no definition may flip it either
        expect(line, `${f} enables a digest engine`).not.toMatch(/digest_engine_enabled\s*=\s*true/i);
        expect(line, `${f} seeds a digest engine ON`).not.toMatch(/digest_engine_enabled[^,)]*,\s*true/i);
      }
    }
    // …and the artifact that IS allowed to do it is the reviewed one
    const artifact = readFileSync(resolve(ROOT, 'scripts', 'rollout', 'notif-10cb', 'sql', 'enable_engine.sql'), 'utf8');
    expect(artifact).toContain('SET digest_engine_enabled = true');
  });

  it('the digest cron is scheduled INACTIVE, in the same transaction that creates it', () => {
    const f = '20261012100000_notif_10cb_digest_cron_inert.sql';
    const sql = read(f);
    const scheduled = sql.indexOf("cron.schedule('notification-digest-worker'");
    const deactivated = sql.indexOf('cron.alter_job(v_jobid, active := false)');
    expect(scheduled).toBeGreaterThan(0);
    expect(deactivated).toBeGreaterThan(scheduled);   // no window in which a tick could fire
    // and no later migration arms it
    for (const other of NOTIF) {
      for (const line of installStatements(read(other))) {
        expect(line, `${other} arms a cron job`).not.toMatch(/active\s*:=\s*true/);
        expect(line, `${other} arms a cron job`).not.toMatch(/SET active\s*=\s*true/i);
      }
    }
  });

  it('both unopened delivery paths ship INERT, and only the pre-existing live path is active', () => {
    const sql = read('20261028100000_notif_n5_activation_boundary.sql');
    expect(sql).toMatch(/VALUES \('email:digest', 'inert'\), \('whatsapp:instant', 'inert'\)/);
    // exactly one seeded active path, and it is the one that was already sending
    const active = [...sql.matchAll(/VALUES \('([a-z:]+)', 'active'/g)].map((m) => m[1]);
    expect(active).toEqual(['email:instant']);
    // no other migration opens a path
    for (const f of NOTIF.filter((n) => n !== '20261028100000_notif_n5_activation_boundary.sql')) {
      for (const line of installStatements(read(f))) {
        expect(line, `${f} opens a delivery path`).not.toMatch(/record_notification_activation_boundary\s*\(/);
        expect(line, `${f} writes an activation boundary`).not.toMatch(/INSERT INTO public\.notification_activation_boundaries/);
      }
    }
  });

  it('no migration sends anything, or asks anyone else to, while it is being applied', () => {
    for (const f of NOTIF) {
      for (const line of installStatements(read(f))) {
        expect(line, `${f} makes an outbound call`).not.toMatch(/net\.http_(post|get|delete)\s*\(/);
        expect(line, `${f} reaches a provider`).not.toMatch(/api\.resend\.com|graph\.facebook\.com/);
      }
    }
  });

  it('install-time dynamic SQL is DDL, never a send', () => {
    // EXECUTE at install is legitimate here — the chain builds RLS and grants dynamically — so it
    // is not banned; what it may not do is carry a send. Checked independently of the dollar-quote
    // classification, because a send hidden in a literal that is later ALSO used as a cron command
    // would otherwise be deferred away.
    for (const f of NOTIF) {
      const sql = read(f);
      for (const m of sql.matchAll(/\bEXECUTE\b[\s\S]{0,400}?;/gi)) {
        const stmt = m[0];
        expect(stmt, `${f} EXECUTEs something that reaches a provider`)
          .not.toMatch(/net\.http_(post|get|delete)|api\.resend\.com|graph\.facebook\.com/i);
      }
    }
  });

  it('no migration claims, dispatches or resolves a real send at install time', () => {
    // the pipeline's own send authorities may be DEFINED by a migration, never CALLED by one
    const authorities = [
      'claim_notification_outbox_batch', 'claim_notification_digest_group',
      'materialize_notification_digest_groups', 'begin_notification_digest_attempt',
      'record_notification_digest_result', 'enqueue_notification',
    ];
    for (const f of NOTIF) {
      for (const line of installStatements(read(f))) {
        for (const fn of authorities) {
          if (new RegExp(`(SELECT|PERFORM)\\s+(public\\.)?${fn}\\s*\\(`, 'i').test(line)) {
            throw new Error(`${f} calls the send authority ${fn} at install time: ${line.slice(0, 120)}`);
          }
        }
      }
    }
  });

  it('the operations doc’s inertness claim names each of these facts', () => {
    const doc = readFileSync(resolve(ROOT, 'docs', 'NOTIFICATION_OPERATIONS.md'), 'utf8');
    const section = doc.slice(doc.indexOf('## 8. Release inertness'));
    expect(section).toContain('installed **inactive**');
    expect(section).toContain('`digest_engine_enabled` is false for every event');
    expect(section).toContain('seeded **inert**');
    expect(section).toContain('no migration sends anything');
  });
});
