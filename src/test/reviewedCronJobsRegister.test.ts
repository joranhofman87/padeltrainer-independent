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

/** Migrations apply in filename order; that order is what decides a job's final state. */
const migrationFiles = () => readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();

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

const unquote = (arg: string): string | null => {
  const t = arg.trim();
  const dollar = t.match(/^(\$[A-Za-z_]*\$)([\s\S]*)\1$/);
  if (dollar) return dollar[2];
  const single = t.match(/^E?'([\s\S]*)'$/);
  if (single) return single[1];
  return null;
};

type Call = { file: string; name: string; command: string | null; raw: string };

/** Every cron.schedule / cron.unschedule call, in migration order. */
function cronCalls() {
  const schedules: Call[] = [];
  const unresolved: string[] = [];
  for (const file of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    for (const m of sql.matchAll(/cron\.(schedule|unschedule)\s*\(/g)) {
      const kind = m[1] as 'schedule' | 'unschedule';
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
      let command = unquote(args[2]);
      if (command === null) {
        // The command is an identifier (`cron_command`) — resolve its assignment in this file.
        const ident = args[2].trim();
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(ident)) {
          const assign = sql.match(new RegExp(`${ident}\\s*:=\\s*([\\s\\S]*?);\\s*\\n`));
          if (assign) command = unquote(assign[1]) ?? assign[1];
        }
      }
      if (command === null) {
        unresolved.push(`${file}: cron.schedule('${name}') command could not be resolved: ${args[2].trim().slice(0, 60)}`);
        continue;
      }
      schedules.push({ file, name, command, raw: args[2] });
    }
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
      const want = OUTBOUND.test(s.command!) ? 'yes' : 'no';
      if (entry.outbound !== want) {
        wrong.push(`${name}: reviewed='${entry.outbound}' but the command scheduled in ${s.file} is '${want}'`);
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
