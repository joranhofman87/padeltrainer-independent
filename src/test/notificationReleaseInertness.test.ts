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
type DollarToken = { index: number; text: string };

/**
 * SQL with comments and quoted strings blanked, plus only the dollar tags that occurred in code.
 *
 * The blanked string has exactly the same length as the source. Keeping indexes stable lets the
 * classifier inspect executable context without allowing prose such as
 * `/* cron.schedule(... $do$ ...` or `'cron.schedule(... $do$ ...'` to manufacture delimiters or
 * a cron call. Dollar bodies themselves are deliberately not skipped: a kept DO body executes at
 * install time, and may contain a nested dollar-quoted cron command that really is deferred.
 */
function lexicalSql(sql: string): { code: string; dollars: DollarToken[] } {
  const code = sql.split('');
  const dollars: DollarToken[] = [];
  const dollarAt = (at: number): string | null =>
    sql.slice(at).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0] ?? null;
  const blank = (from: number, to: number) => {
    for (let at = from; at < to; at += 1) {
      if (code[at] !== '\n' && code[at] !== '\r') code[at] = ' ';
    }
  };

  let i = 0;
  while (i < sql.length) {
    if (sql.startsWith('--', i)) {
      const from = i;
      const newline = sql.indexOf('\n', i + 2);
      i = newline < 0 ? sql.length : newline;
      blank(from, i);
      continue;
    }
    if (sql.startsWith('/*', i)) {
      const from = i;
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.startsWith('/*', i)) { depth += 1; i += 2; }
        else if (sql.startsWith('*/', i)) { depth -= 1; i += 2; }
        else i += 1;
      }
      blank(from, i);
      continue;
    }
    if (sql[i] === "'") {
      const from = i;
      const escapeString = i > 0 && /[eE]/.test(sql[i - 1])
        && (i < 2 || !/[A-Za-z0-9_$]/.test(sql[i - 2]));
      i += 1;
      while (i < sql.length) {
        if (escapeString && sql[i] === '\\') { i = Math.min(sql.length, i + 2); continue; }
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i += 1; break; }
        i += 1;
      }
      blank(from, i);
      continue;
    }
    if (sql[i] === '"') {
      const from = i;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') { i += 2; continue; }
        if (sql[i] === '"') { i += 1; break; }
        i += 1;
      }
      blank(from, i);
      continue;
    }
    if (sql[i] === '$') {
      const text = dollarAt(i);
      if (text) {
        dollars.push({ index: i, text });
        i += text.length;
        continue;
      }
    }
    i += 1;
  }
  return { code: code.join(''), dollars };
}

const matchingDollarClose = (dollars: DollarToken[], opener: number): number => {
  for (let candidate = opener + 1; candidate < dollars.length; candidate += 1) {
    if (dollars[candidate].text === dollars[opener].text) return candidate;
  }
  return -1;
};

/**
 * Dollar openers that belong to CREATE FUNCTION / PROCEDURE bodies.
 *
 * This is deliberately a forward lexical statement scan. Statement boundaries exist only in
 * executable SQL: semicolons inside strings, quoted identifiers, comments and dollar bodies do
 * not reset the statement start. That makes the CREATE anchor the actual executable start rather
 * than "whatever happened to occur in the previous 400 characters".
 */
function deferredRoutineBodyOpeners(
  sql: string,
  lexical: ReturnType<typeof lexicalSql>,
): Set<number> {
  const openers = new Set<number>();
  let statementCode = '';
  const tokenAt = new Map(lexical.dollars.map((token, index) => [token.index, index]));
  let i = 0;

  while (i < sql.length) {
    const opener = tokenAt.get(i);
    if (opener !== undefined) {
      const close = matchingDollarClose(lexical.dollars, opener);
      if (close >= 0) {
        if (/^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b[\s\S]*\bAS\s*$/i.test(statementCode)) {
          openers.add(i);
        }
        statementCode += ' ';
        i = lexical.dollars[close].index + lexical.dollars[close].text.length;
        continue;
      }
    }
    if (lexical.code[i] === ';') {
      statementCode = '';
      i += 1;
      continue;
    }
    statementCode += lexical.code[i];
    i += 1;
  }
  return openers;
}

function installStatements(sql: string): string[] {
  const deferred: [number, number][] = [];
  const closers = new Set<number>();      // closing tags of blocks we KEPT — never re-open them
  const lexical = lexicalSql(sql);
  const routineBodies = deferredRoutineBodyOpeners(sql, lexical);
  for (let opener = 0; opener < lexical.dollars.length; opener += 1) {
    const current = lexical.dollars[opener];
    if (closers.has(current.index)) continue;   // end of a kept block, not a new opener
    const closeToken = matchingDollarClose(lexical.dollars, opener);
    if (closeToken < 0) continue;               // uncertain input stays visible: fail closed
    const close = lexical.dollars[closeToken];
    const prefix = lexical.code.slice(0, current.index);
    const statementBefore = prefix.slice(prefix.lastIndexOf(';') + 1);
    // a cron COMMAND: either the literal is syntactically an argument of the schedule/alter call,
    // or it is assigned to a variable this file hands to one — but in the second case ONLY if that
    // variable is never EXECUTEd. "It is later scheduled" does not prove the block did not also
    // run it during installation, which is exactly how a send could hide:
    //   cmd := format($cmd$SELECT net.http_post(…)$cmd$);  EXECUTE cmd;  PERFORM cron.schedule(…, cmd);
    const assignedTo = statementBefore.match(/(\w+)\s*(?:text\s*)?:=\s*(?:format\s*\(\s*)?$/i)?.[1];
    let containerEnd = sql.length;
    for (const keptClose of closers) {
      if (keptClose > close.index && keptClose < containerEnd) containerEnd = keptClose;
    }
    const after = lexical.code.slice(close.index + close.text.length, containerEnd);
    const scheduledLater = !!assignedTo
      && new RegExp(`cron\\.(schedule|alter_job)\\s*\\([^;]*\\b${assignedTo}\\b`, 'i').test(after);
    const executedHere = !!assignedTo && new RegExp(`\\bEXECUTE\\s+${assignedTo}\\b`, 'i').test(after);
    const isCronCommand = /cron\.(schedule|alter_job)\s*\([^;]*$/i.test(statementBefore)
      || (scheduledLater && !executedHere);
    const isFunctionBody = routineBodies.has(current.index);
    if (isFunctionBody || isCronCommand) {
      deferred.push([current.index, close.index + close.text.length]);
      opener = closeToken;                       // its contents are deferred; skip them whole
    } else {
      // KEPT — a DO block runs at install, so keep scanning INSIDE it: the digest cron's command
      // literal lives inside one, and a naive skip-to-close would leave that literal in the scan
      // (and, worse, could pair the block's closing tag with the next block's opening one).
      closers.add(close.index);
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

describe('install-time SQL classification regressions', () => {
  it('defers a routine body whose declaration is longer than the old 400-character lookbehind', () => {
    const args = Array.from({ length: 45 }, (_, i) => `p_${i} text DEFAULT 'value;${i}'`).join(',\n');
    const sql = `CREATE OR REPLACE FUNCTION public.long_header(${args}) RETURNS void LANGUAGE plpgsql AS $body$
      BEGIN PERFORM public.enqueue_notification('deferred'); END
    $body$;`;
    expect(installStatements(sql).join('\n')).not.toContain("enqueue_notification('deferred')");
  });

  it('keeps DO blocks, dynamic SQL and ordinary install-time calls visible', () => {
    const sql = `
      DO $tag$ BEGIN PERFORM public.enqueue_notification('do'); END $tag$;
      EXECUTE 'SELECT public.enqueue_notification(''dynamic'')';
      SELECT public.enqueue_notification('ordinary');
    `;
    const visible = installStatements(sql).join('\n');
    expect(visible).toContain("enqueue_notification('do')");
    expect(visible).toContain("enqueue_notification(''dynamic'')");
    expect(visible).toContain("enqueue_notification('ordinary')");
  });

  it('fake CREATE text and semicolons in strings/comments cannot hide an install-time call', () => {
    const sql = `
      SELECT 'CREATE FUNCTION public.fake() AS $x$ ; $x$;';
      /* CREATE PROCEDURE public.fake_two() AS $y$ ; $y$; */
      -- CREATE FUNCTION public.fake_three() AS $z$ ; $z$;
      PERFORM public.enqueue_notification('still-visible');
    `;
    expect(installStatements(sql).join('\n')).toContain("enqueue_notification('still-visible')");
  });

  it('fake cron syntax and dollar tags in prose cannot defer a real DO block', () => {
    const commentSql = `
      /* cron.schedule('not-code', '* * * * *', $do$ SELECT 1 $do$) */
      DO $do$
        BEGIN PERFORM public.enqueue_notification('comment-visible'); END
      $do$;
    `;
    expect(installStatements(commentSql).join('\n'))
      .toContain("enqueue_notification('comment-visible')");

    const stringSql = `
      DO $outer$
      BEGIN
        IF 'cron.schedule(''not-code'', ''* * * * *'', $do$ SELECT 1 $do$)' IS NOT NULL THEN
          EXECUTE $sql$
            DO $do$
            BEGIN
              PERFORM public.enqueue_notification('string-visible');
            END
            $do$;
          $sql$;
        END IF;
      END
      $outer$;
    `;
    expect(installStatements(stringSql).join('\n'))
      .toContain("enqueue_notification('string-visible')");
  });
});

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
