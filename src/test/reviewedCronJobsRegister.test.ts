// @vitest-environment node
// 10c-b H — every cron job a migration schedules must be in the clone-safety reviewed set,
// classified the way its command actually behaves.
//
// `scripts/rollout/notif-10ca3/run-rollout.sh` FAILS CLOSED on any live cron job that is not in
// `clone-safety/reviewed-cron-jobs.tsv` ("UNREVIEWED cron job present" aborts the clone-source
// quiesce), and on a classification that no longer matches the live command ("CLASSIFICATION
// DRIFT"). That is the right posture — a job added at runtime is exactly what a clone must not
// inherit — but nothing connected it to the migrations, so a slice could add a cron and the gap
// would surface only in front of an operator, mid-rollout, with production paused.
//
// It already happened: 10c-b F scheduled `notification-digest-worker` and it was never registered.
//
// THIS FILE PARSES THE CALLS RATHER THAN PATTERN-MATCHING THEM. The first version used two
// regexes and was much weaker than it looked: it treated "was ever unscheduled" as a job's final
// state (ten of eleven jobs here are unschedule-then-reschedule, so their entries could be deleted
// and it still passed), and it only recognised an immediately dollar-quoted command, so six of
// eleven jobs were never classified at all. Anything this parser cannot resolve now FAILS LOUDLY
// instead of being skipped.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');
const TSV = join(process.cwd(), 'scripts', 'rollout', 'notif-10ca3', 'clone-safety', 'reviewed-cron-jobs.tsv');

/** The clone-safety inventory's own outbound test (sql/clone_source_inventory.sql). */
const OUTBOUND = /net\.http_(post|get|delete)|http_post|http_get|dblink/i;

/**
 * Every way this repo can reach pg_cron's scheduling API. `cron.schedule(` alone was too narrow:
 * `cron.schedule_in_database(...)` (which the repo's own sanitizer already treats as a clone
 * hazard), a quoted identifier, whitespace around the dot, or a comment between the name and the
 * paren were all invisible — and an unregistered job introduced through one of them left the
 * "unreadable" list empty and passed.
 */
const SCHEDULING_CALL =
  /(?:"?cron"?\s*\.\s*"?(schedule_in_database|schedule|unschedule)"?)\s*(?:--[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*\(/gi;

/** Migrations apply in filename order; that order is what decides a job's final state. */
const migrationFiles = () => readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();

/**
 * Blank out SQL comments, preserving every byte offset (spaces in, newlines kept), and NEVER
 * touching the inside of a string or dollar-quoted block — a command body legitimately contains
 * `--` and `/*`.
 *
 * Everything below scans the blanked copy. Reading the raw text meant a commented-out assignment
 * could be selected as the "nearest" one: an outbound assignment followed by
 * `-- cron_command := 'SELECT local_only();';` classified the job as non-outbound, silently.
 */
export function blankComments(sql: string): string {
  const out = sql.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  // A dollar block is either EXECUTABLE (a routine body: `DO $do$`, `AS $$`, `AS $function$`) or
  // DATA (the `$cmd$…$cmd$` command handed to cron.schedule). Comments must be blanked inside the
  // first and left completely alone inside the second — and getting this wrong in either direction
  // is a real defect. Skipping ALL dollar blocks meant comments were never blanked anywhere that
  // mattered, because essentially every cron call in this repo sits inside a `DO $do$` body.
  const isRoutineBody = (at: number) => /\b(DO|AS)\s*$/i.test(sql.slice(Math.max(0, at - 40), at));
  const scan = (from: number, to: number) => {
    let i = from;
    while (i < to) {
      if (sql[i] === '$') {
        const tag = sql.slice(i, to).match(/^\$[A-Za-z_]*\$/);
        if (tag) {
          const close = sql.indexOf(tag[0], i + tag[0].length);
          const end = close < 0 ? to : close;
          if (isRoutineBody(i)) scan(i + tag[0].length, end);   // executable: look inside
          i = close < 0 ? to : close + tag[0].length;           // data: skip entirely
          continue;
        }
      }
      if (sql[i] === "'") {
        i++;
        while (i < to) {
          if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
          if (sql[i] === "'") { i++; break; }
          if (sql[i] === '\\') { i += 2; continue; }
          i++;
        }
        continue;
      }
      if (sql[i] === '-' && sql[i + 1] === '-') {
        const e = sql.indexOf('\n', i);
        const stop = e < 0 || e > to ? to : e;
        blank(i, stop); i = stop; continue;
      }
      if (sql[i] === '/' && sql[i + 1] === '*') {
        const e = sql.indexOf('*/', i + 2);
        const stop = e < 0 || e + 2 > to ? to : e + 2;
        blank(i, stop); i = stop; continue;
      }
      i++;
    }
  };
  scan(0, sql.length);
  return out.join('');
}

/**
 * Split the argument list of a `cron.schedule(...)` call starting at the '(' index. Respects
 * nested parens, single-quoted strings (with '' escapes) and dollar-quoted blocks, so a command
 * containing commas or parentheses cannot split an argument in the wrong place.
 */
function splitArgs(sql: string, openParen: number): string[] | null {
  const args: string[] = [];
  let depth = 0, start = openParen + 1, i = openParen;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === '$') {                                    // dollar-quoted block
      const tag = sql.slice(i).match(/^\$[A-Za-z_]*\$/);
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        if (end < 0) return null;
        i = end + tag[0].length;
        continue;
      }
    }
    if (ch === "'") {                                    // single-quoted string
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        if (sql[i] === '\\') { i += 2; continue; }        // E'' escape strings
        i++;
      }
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) { args.push(sql.slice(start, i)); return args; }
    } else if (ch === ',' && depth === 1) {
      args.push(sql.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  return null;
}

/**
 * A WHOLE-ARGUMENT literal, or nothing. The greedy `^E?'(.*)'$` this replaced accepted
 * `'SELECT net.ht' || 'tp_post(...)'` as a single literal and then classified the result
 * non-outbound, while PostgreSQL evaluates it to a net.http_post call. Anything that is an
 * EXPRESSION rather than one literal must fall through to the fail-loud path, not be guessed at.
 */
const unquote = (arg: string): string | null => {
  const t = arg.trim();
  const dollar = t.match(/^\$[A-Za-z_]*\$/);
  if (dollar) {
    const end = t.indexOf(dollar[0], dollar[0].length);
    // the closing tag must be the END of the argument — otherwise it is `$a$..$a$ || x`
    if (end < 0 || end + dollar[0].length !== t.length) return null;
    return t.slice(dollar[0].length, end);
  }
  if (!/^E?'/.test(t)) return null;
  // E'' ESCAPES ARE DECODED, NOT PRESERVED. `E'net.http_\x70ost(…)'` is `net.http_post(…)` to
  // PostgreSQL; keeping the escape as text classified it non-outbound — a definite, wrong `no`
  // that would then fail as CLASSIFICATION DRIFT mid-rollout. Any escape not decoded here returns
  // null rather than a guess.
  const escaped = t[0] === 'E';
  let i = escaped ? 2 : 1;
  let out = '';
  while (i < t.length) {
    if (t[i] === "'" && t[i + 1] === "'") { out += "'"; i += 2; continue; }
    if (t[i] === "'") { i++; break; }
    if (escaped && t[i] === '\\') {
      const n = t[i + 1];
      if (n === "'" || n === '\\' || n === '"') { out += n; i += 2; continue; }
      if (n === 'n') { out += '\n'; i += 2; continue; }
      if (n === 'r') { out += '\r'; i += 2; continue; }
      if (n === 't') { out += '\t'; i += 2; continue; }
      const hex = t.slice(i + 1).match(/^x([0-9a-fA-F]{1,2})/);
      if (hex) { out += String.fromCharCode(parseInt(hex[1], 16)); i += 1 + hex[0].length; continue; }
      const oct = t.slice(i + 1).match(/^([0-7]{1,3})/);
      if (oct) { out += String.fromCharCode(parseInt(oct[1], 8)); i += 1 + oct[0].length; continue; }
      return null;                                    // an escape we do not decode — fail closed
    }
    out += t[i]; i++;
  }
  // ...and nothing may follow the closing quote: `'a' || 'b'` is a concatenation, not a literal.
  return t.slice(i).trim() === '' ? out : null;
};

/**
 * The value of `ident` as assigned NEAREST BEFORE `callAt` — not the file's first assignment.
 * 20260606120000 assigns `cron_command` three times, so taking the first classified the
 * fetch-logo and invoice jobs from the ENRICHMENT command. All three are outbound, so the
 * result happened to be right, which is why no register mutant could see it; it is unit-tested
 * below instead.
 */
export function nearestAssignment(sql: string, ident: string, callAt: number): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ident)) return null;
  let best: { expr: string; end: number } | null = null;
  for (const a of sql.matchAll(new RegExp(`\\b${ident}\\s*:=\\s*([\\s\\S]*?);\\s*\\n`, 'g'))) {
    if (a.index! < callAt) best = { expr: a[1], end: a.index! + a[0].length }; else break;
  }
  if (!best) return null;
  // TEXTUAL PRECEDENCE IS NOT CONTROL FLOW. If a branch, a loop, or another routine's body sits
  // between the assignment and the call, the value that actually reaches cron.schedule may come
  // from somewhere else — an IF assigning an outbound command in one arm and a local one in the
  // last arm would always be read from the last, and an assignment inside an EXCEPTION arm would
  // be preferred over the outbound value the normal path actually keeps. Refuse rather than pick
  // the textual predecessor. (BEGIN/END are in the list precisely so a block boundary counts.)
  const between = sql.slice(best.end, callAt);
  if (/\b(IF|ELSIF|ELSE|CASE|LOOP|WHILE|EXCEPTION|BEGIN|END|DECLARE|CREATE\s+(OR\s+REPLACE\s+)?FUNCTION)\b/i.test(between)) return null;
  return best.expr;
}

type Call = { file: string; name: string; outbound: 'yes' | 'no'; raw: string };

/**
 * Classify a command EXPRESSION as outbound — but only from a form whose text can be PROVEN.
 *
 * THE RULE THIS REPLACED WAS WRONG, and it is worth saying so here rather than letting anyone
 * re-derive it. It claimed "an evaluated expression can only ADD to what its literals show, never
 * remove it, so a marker anywhere in the literals means yes". Both halves are false:
 *   - `replace('… net.http_post …', 'http_post', 'noop')` REMOVES the marker and never reaches
 *     the network, yet reads as outbound;
 *   - `CASE WHEN … THEN 'net.ht' ELSE 'tp_post()' END` has mutually exclusive branches, and
 *     reading their literals together MANUFACTURES a marker no branch produces.
 * A wrong `yes` is not harmless either: it makes a correct `no` entry fail the register.
 *
 * So only three provable forms are accepted:
 *   - a whole literal                       → definite, both ways
 *   - a pure `||` concatenation of literals → definite, both ways (evaluated in order)
 *   - `format(<literal template>, …)`, and only when the call IS the whole expression → `yes` if
 *     the TEMPLATE carries the marker, since format always emits its template text; its absence
 *     stays UNKNOWN, because an argument could supply one
 * Everything else is UNKNOWN and fails loudly rather than being inferred.
 */
export function classifyCommand(expr: string): 'yes' | 'no' | null {
  const whole = unquote(expr);
  if (whole !== null) return OUTBOUND.test(whole) ? 'yes' : 'no';

  // A PURE `||` CONCATENATION OF LITERALS. Joined with NOTHING, because a concatenation can split
  // the marker itself — `'SELECT net.ht' || 'tp_post(…)'` evaluates to a net.http_post call, and
  // any separator between the parts would hide it.
  const pieces = splitTopLevel(expr, '||');
  if (pieces && pieces.length > 1) {
    const lits = pieces.map(unquote);
    if (lits.every((l) => l !== null)) return OUTBOUND.test(lits.join('')) ? 'yes' : 'no';
  }

  // `format(<literal template>, …)`: format always emits its template text, so a marker in the
  // TEMPLATE is definite. Its absence is not — an argument could supply one — so that is UNKNOWN.
  // ...and the format() call must BE the whole expression. splitArgs finds its closing paren, but
  // `format('{"x":"net.http_post","y":"SELECT 1"}')::jsonb ->> 'y'` evaluates to `SELECT 1` while
  // still starting with `format(` — so the paren has to consume everything.
  const trimmed = expr.trim();
  const fmt = trimmed.match(/^format\s*\(/i);
  if (fmt) {
    const open = fmt[0].length - 1;
    const args = splitArgs(trimmed, open);
    const consumed = args ? open + 1 + args.join(',').length + 1 : -1;
    if (args && consumed === trimmed.length) {
      const template = args.length ? unquote(args[0]) : null;
      if (template !== null && OUTBOUND.test(template)) return 'yes';
    }
  }
  return null;
}

/** Split on a top-level operator, respecting quoting and parens. Null if the text is unbalanced. */
function splitTopLevel(expr: string, op: string): string[] | null {
  const args = splitArgs(`(${expr})`, 0);
  if (!args) return null;
  const inner = args[0];
  const out: string[] = [];
  let depth = 0, start = 0, i = 0;
  while (i < inner.length) {
    const ch = inner[i];
    if (ch === '$') {
      const tag = inner.slice(i).match(/^\$[A-Za-z_]*\$/);
      if (tag) {
        const e = inner.indexOf(tag[0], i + tag[0].length);
        if (e < 0) return null;
        i = e + tag[0].length;
        continue;
      }
    }
    if (ch === "'") {
      i++;
      while (i < inner.length) {
        if (inner[i] === "'" && inner[i + 1] === "'") { i += 2; continue; }
        if (inner[i] === "'") { i++; break; }
        if (inner[i] === '\\') { i += 2; continue; }
        i++;
      }
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && inner.startsWith(op, i)) { out.push(inner.slice(start, i)); i += op.length; start = i; continue; }
    i++;
  }
  out.push(inner.slice(start));
  return out;
}

/** Every cron.schedule / cron.unschedule call, in migration order. */
export function scanMigration(file: string, rawSql: string) {
  const schedules: Call[] = [];
  const unresolved: string[] = [];
  {
    // Scanned COMMENT-BLANKED, offsets preserved: a commented-out call or assignment
    // must not be read as live code.
    const sql = blankComments(rawSql);
    for (const m of sql.matchAll(SCHEDULING_CALL)) {
      const kind = m[1].toLowerCase().startsWith('unschedule') ? 'unschedule' : 'schedule';
      const args = splitArgs(sql, m.index! + m[0].length - 1);
      if (!args) { unresolved.push(`${file}: unparseable cron.${kind}( call`); continue; }
      const name = unquote(args[0]);
      if (name === null) {
        // A dynamic job name cannot be reconciled against a static register at all.
        unresolved.push(`${file}: cron.${kind}() with a NON-LITERAL job name: ${args[0].trim().slice(0, 60)}`);
        continue;
      }
      if (kind !== 'schedule') continue;
      if (args.length < 3) { unresolved.push(`${file}: cron.schedule('${name}') with fewer than 3 arguments`); continue; }
      let outbound = classifyCommand(args[2]);
      if (outbound === null) {
        // The command is an identifier (`cron_command`) — resolve its assignment in this file.
        // THE NEAREST PRECEDING ASSIGNMENT, not the file's first. 20260606120000 assigns
        // `cron_command` three times, so taking the first classified the fetch-logo and invoice
        // jobs from the ENRICHMENT command — they are all outbound, so it happened to be
        // harmless, which is the worst kind of wrong.
        const ident = args[2].trim();
        const expr = nearestAssignment(sql, ident, m.index!);
        if (expr !== null) outbound = classifyCommand(expr);
      }
      if (outbound === null) {
        unresolved.push(`${file}: cron.schedule('${name}') command could not be classified: ${args[2].trim().slice(0, 60)}`);
        continue;
      }
      schedules.push({ file, name, outbound, raw: args[2] });
    }
  }
  return { schedules, unresolved };
}

/** Every migration, in apply order. */
function cronCalls() {
  const schedules: Call[] = [];
  const unresolved: string[] = [];
  for (const file of migrationFiles()) {
    const r = scanMigration(file, readFileSync(join(MIGRATIONS, file), 'utf8'));
    schedules.push(...r.schedules);
    unresolved.push(...r.unresolved);
  }
  return { schedules, unresolved };
}

const reviewed = (() => {
  const rows = readFileSync(TSV, 'utf8').split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => l.split('\t'));
  return new Map(rows.map((r) => [r[0], { outbound: r[1], note: r[2] ?? '' }]));
})();

const { schedules, unresolved } = cronCalls();

describe('H — the clone-safety cron register covers every scheduled job', () => {
  // A form this parser cannot read is a HOLE, not a pass. Skipping the unreadable ones is exactly
  // how the first version classified only five of eleven jobs while reporting success.
  it('every cron.schedule call in the migrations is readable', () => {
    expect(unresolved).toEqual([]);
  });

  // Jobs a migration schedules but that are deliberately NOT expected in production. Empty today:
  // every job any migration schedules is registered. Adding a name here is a deliberate act
  // meaning "retired — a clone will not see it", and it carries its reason.
  const RETIRED = new Map<string, string>();

  it('every job any migration schedules is in reviewed-cron-jobs.tsv', () => {
    // NOT "every job the migrations LEAVE scheduled". Three registered jobs
    // (enrich-locations-background, fetch-location-logos-background, invoice-health-check-daily)
    // have an unschedule as their last migration operation because they are re-created at RUNTIME
    // by a scheduler function — they are live in production and must stay registered. Exempting
    // them on final state left their entries freely deletable, so the rule is scheduled-ever minus
    // an explicit retirement list.
    const missing = [...new Set(schedules.map((s) => s.name))]
      .filter((name) => !RETIRED.has(name))
      .filter((name) => !reviewed.has(name));
    expect(missing, 'run-rollout.sh aborts the clone-source quiesce on an unreviewed cron job — add these to clone-safety/reviewed-cron-jobs.tsv with their outbound classification').toEqual([]);
  });

  // The classification is compared against the LIVE command during a rollout, so a wrong one
  // reads as CLASSIFICATION DRIFT mid-window. Every resolvable command is checked, using the
  // inventory SQL's own outbound test.
  it('each registered job is classified the way its command behaves', () => {
    // EVERY registered job with a resolvable command is classified, using its LAST schedule call —
    // including the RUNTIME-SCHEDULED ones. Skipping a job because its last migration operation was
    // an unschedule was wrong: those jobs are re-created at runtime by a function whose body a
    // migration defines, so the command text is right there, and skipping them left their
    // classifications free to be flipped. (Verified: flipping `enrich-locations-background` or
    // `fetch-location-logos-background` used to pass.)
    const lastSchedule = new Map<string, Call>();
    for (const s of schedules) lastSchedule.set(s.name, s);
    const wrong: string[] = [];
    for (const [name, entry] of reviewed) {
      const s = lastSchedule.get(name);
      if (!s) continue;                                  // no static command; nothing to compare
      if (entry.outbound !== s.outbound) {
        wrong.push(`${name}: reviewed='${entry.outbound}' but the command scheduled in ${s.file} is '${s.outbound}'`);
      }
    }
    expect(wrong).toEqual([]);
  });

  // ...and a registered job whose command this file CANNOT read statically is named, so the
  // register's coverage is a known quantity rather than an assumption.
  it('reports which registered jobs have no statically-readable command', () => {
    const named = new Set(schedules.map((s) => s.name));
    const unclassifiable = [...reviewed.keys()].filter((n) => !named.has(n));
    // Today every registered job is reachable from a migration. If that stops being true, this
    // fails and the new one has to be classified by hand, deliberately.
    expect(unclassifiable).toEqual([]);
  });

  it('the register has no entry for a job nothing schedules', () => {
    // A stale entry is a smaller problem than a missing one, but it is how the file drifts from
    // reality — and a reader trusts it to describe production.
    const scheduledNames = new Set(schedules.map((s) => s.name));
    const orphaned = [...reviewed.keys()].filter((n) => !scheduledNames.has(n));
    // Runtime-scheduled jobs are created by a function, not a migration, and are registered by
    // hand — the TSV says so in their note.
    const runtime = orphaned.filter((n) => !/RUNTIME-SCHEDULED/i.test(reviewed.get(n)!.note));
    expect(runtime).toEqual([]);
  });

  it('the digest cron is registered, outbound, and marked as shipping inactive', () => {
    const entry = reviewed.get('notification-digest-worker');
    expect(entry, 'notification-digest-worker must be in the reviewed cron set').toBeTruthy();
    expect(entry!.outbound).toBe('yes');
    expect(entry!.note).toMatch(/INACTIVE/i);
  });
});

// ── the parser's own defects, pinned directly ───────────────────────────────────────────────
// These three were all live bugs in the first version of this file, and none of them could be
// caught by mutating the register: the real data happens to hide each one.
describe('H — the cron parser cannot be fooled the ways it was', () => {
  it('binds a command variable to the NEAREST PRECEDING assignment', () => {
    const sql = [
      "  cron_command := 'SELECT net.http_post(url := ''x'');';",
      "  PERFORM cron.schedule('a', '* * * * *', cron_command);",
      "  cron_command := 'SELECT public.some_local_thing();';",
      "  PERFORM cron.schedule('b', '* * * * *', cron_command);",
      '',
    ].join('\n');
    const callB = sql.lastIndexOf('cron.schedule');
    const callA = sql.indexOf('cron.schedule');
    expect(nearestAssignment(sql, 'cron_command', callA)).toMatch(/http_post/);
    // ...and the SECOND call must not inherit the first command.
    expect(nearestAssignment(sql, 'cron_command', callB)).toMatch(/some_local_thing/);
    expect(nearestAssignment(sql, 'cron_command', callB)).not.toMatch(/http_post/);
  });

  it('refuses a variable whose assignment is separated from the call by a BRANCH', () => {
    // Textual precedence is not control flow: the IF's outbound arm may be the one that runs,
    // while the last textual assignment is the local one.
    const sql = [
      "  IF v_env = 'prod' THEN",
      "    cron_command := 'SELECT net.http_post(url := ''x'');';",
      '  ELSE',
      "    cron_command := 'SELECT public.local_only();';",
      '  END IF;',
      "  PERFORM cron.schedule('a', '* * * * *', cron_command);",
      '',
    ].join('\n');
    expect(nearestAssignment(sql, 'cron_command', sql.indexOf('cron.schedule'))).toBeNull();
  });

  it('never reads a COMMENTED-OUT assignment as the live one', () => {
    // Silent false negative: the live command is outbound, the commented one is not, and reading
    // the raw text picked the comment because it is nearer.
    const raw = [
      "  cron_command := 'SELECT net.http_post(url := ''x'');';",
      "  -- cron_command := 'SELECT public.local_only();';",
      "  PERFORM cron.schedule('a', '* * * * *', cron_command);",
      '',
    ].join('\n');
    const sql = blankComments(raw);
    expect(sql).toHaveLength(raw.length);                       // offsets preserved
    expect(nearestAssignment(sql, 'cron_command', sql.indexOf('cron.schedule'))).toMatch(/http_post/);
  });

  it('the real scan path ignores commented-out code, not just the helper', () => {
    // Exercises scanMigration — the function the suite actually runs over the migrations — rather
    // than blankComments in isolation. Testing only the helper left the INTEGRATION unpinned:
    // removing the blanking from the scan passed every test.
    // WRAPPED IN A `DO $do$` BODY, because that is where every cron call in this repo actually
    // lives. A bare-SQL fixture passed even when the blanker skipped dollar blocks wholesale —
    // i.e. when it did nothing at all in the only place that matters.
    const raw = [
      'DO $do$',
      'BEGIN',
      "  cron_command := 'SELECT net.http_post(url := ''x'');';",
      "  -- cron_command := 'SELECT public.local_only();';",
      "  PERFORM cron.schedule('live-one', '* * * * *', cron_command);",
      "  -- PERFORM cron.schedule('ghost-job', '* * * * *', $c$SELECT 1;$c$);",
      'END $do$;',
      '',
    ].join('\n');
    const r = scanMigration('synthetic.sql', raw);
    expect(r.unresolved).toEqual([]);
    expect(r.schedules.map((s) => s.name)).toEqual(['live-one']);   // the commented call is not a job
    expect(r.schedules[0].outbound).toBe('yes');                    // ...from the LIVE assignment
  });

  it('leaves a COMMAND LITERAL inside a routine body untouched', () => {
    // The other half of the same rule: `$cmd$…$cmd$` handed to cron.schedule is DATA. Blanking
    // inside it would corrupt the very text being classified — and it legitimately contains `--`.
    const raw = [
      'DO $do$',
      'BEGIN',
      "  PERFORM cron.schedule('j', '* * * * *', $cmd$",
      "    SELECT net.http_post(url := 'u');  -- a comment INSIDE the command",
      '  $cmd$);',
      'END $do$;',
      '',
    ].join('\n');
    expect(blankComments(raw)).toContain('-- a comment INSIDE the command');
    const r = scanMigration('synthetic.sql', raw);
    expect(r.unresolved).toEqual([]);
    expect(r.schedules.map((x) => [x.name, x.outbound])).toEqual([['j', 'yes']]);
  });

  it('blanks comments WITHOUT touching a command body that contains them', () => {
    // A cron command legitimately contains `--` and `/*`; blanking inside it would corrupt the
    // very text being classified.
    const body = "$c$ SELECT net.http_post(url := 'u'); -- keep me\n /* and me */ $c$";
    expect(blankComments(body)).toBe(body);
  });

  it('refuses an assignment made in an EXCEPTION arm', () => {
    const sql = [
      "  cron_command := 'SELECT net.http_post(url := ''x'');';",
      '  BEGIN',
      '  EXCEPTION WHEN others THEN',
      "    cron_command := 'SELECT public.local_only();';",
      '  END;',
      "  PERFORM cron.schedule('a', '* * * * *', cron_command);",
      '',
    ].join('\n');
    expect(nearestAssignment(sql, 'cron_command', sql.indexOf('cron.schedule'))).toBeNull();
  });

  it('requires format() to BE the whole expression', () => {
    // Starts with `format(` and its literal carries the marker, but it evaluates to `SELECT 1`.
    expect(classifyCommand(
      `format('{"x":"net.http_post","y":"SELECT 1"}')::jsonb ->> 'y'`)).toBeNull();
  });

  it('DECODES E-string escapes rather than reading them as text', () => {
    // PostgreSQL stores `net.http_post`; leaving `\x70` as text classified this as non-outbound.
    expect(classifyCommand(String.raw`E'SELECT net.http_\x70ost(url := ''x'');'`)).toBe('yes');
    expect(classifyCommand(String.raw`E'SELECT net.http_\160ost(url := ''x'');'`)).toBe('yes');
    // a plain E-string with no escape is still just a literal
    expect(classifyCommand(String.raw`E'SELECT public.local_only();'`)).toBe('no');
    // ...but an escape form this does not decode is UNKNOWN, never a definite answer
    expect(classifyCommand(String.raw`E'SELECT net.http_\u0070ost();'`)).toBeNull();
  });

  it('does not claim an expression that could REMOVE or exclude its literals', () => {
    // `replace(...)` evaluates to something that never reaches the network, so a `yes` read off
    // its literals is simply wrong — and a wrong `yes` makes a correct `no` entry fail.
    expect(classifyCommand("replace('SELECT net.http_post()', 'http_post', 'noop')")).toBeNull();
    // mutually exclusive CASE branches must not be spliced into a marker no branch produces
    expect(classifyCommand("CASE WHEN x THEN 'net.ht' ELSE 'tp_post()' END")).toBeNull();
    // ...but format() IS accepted, because it always emits its template
    expect(classifyCommand("format($c$SELECT net.http_post(url := 'u', headers := '%s');$c$, k)")).toBe('yes');
  });

  it('does not mistake a CONCATENATION for a literal', () => {
    // PostgreSQL evaluates this to a net.http_post call; a greedy ^'(.*)'$ read it as one
    // literal whose text contains neither half, and classified it non-outbound.
    expect(classifyCommand("'SELECT net.ht' || 'tp_post(url := ''x'');'")).toBe('yes');
    // ...and an expression whose literals show nothing is UNKNOWN, never 'no'.
    expect(classifyCommand("'SELECT ' || quote_ident(v_fn) || '();'")).toBeNull();
  });

  it('classifies a whole literal definitively in both directions', () => {
    expect(classifyCommand("'SELECT public.release_expired_rebook_holds();'")).toBe('no');
    expect(classifyCommand("$c$ SELECT net.http_post(url := 'x'); $c$")).toBe('yes');
    // a dollar-quoted block followed by anything is an expression, not a literal
    expect(classifyCommand("$c$ SELECT 1; $c$ || v_tail")).toBeNull();
  });

  it('sees every scheduling form, including schedule_in_database and quoted identifiers', () => {
    for (const form of ['cron.schedule(', 'cron.schedule_in_database(', '"cron"."schedule"(',
                        'cron . schedule(', 'cron.unschedule(']) {
      SCHEDULING_CALL.lastIndex = 0;
      expect(SCHEDULING_CALL.test(form), `${form} must be discovered`).toBe(true);
    }
  });
});
