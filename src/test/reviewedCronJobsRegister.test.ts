// @vitest-environment node
// 10c-b H — every cron job a migration schedules must be in the clone-safety reviewed set.
//
// `scripts/rollout/notif-10ca3/run-rollout.sh` FAILS CLOSED on any live cron job that is not in
// `clone-safety/reviewed-cron-jobs.tsv`: "UNREVIEWED cron job present" aborts the clone-source
// INVENTORY command, which is the step that performs this check. That is the right posture — a job added at runtime is exactly what a clone must not
// inherit — but nothing connected that file to the migrations, so 10c-b F scheduled
// `notification-digest-worker` and it was never registered. That inventory step connects and reads,
// but refuses before it CHANGES anything, so the cost would have been an aborted rollout attempt
// rather than a stuck window — and it would have been found by an operator running the rollout
// instead of by CI on the day the job was added.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE NO LONGER CLASSIFIES COMMANDS, after five review rounds that each found another
// defect in exactly that machinery.
//
// The register carries two things per job: that it EXISTS, and whether its command reaches the
// network. An earlier version of this test tried to verify BOTH statically, by parsing the
// migrations. Verifying the second that way is unsound by construction, and the review found it
// one construct at a time: an unschedule-then-reschedule read as retirement; a `cron_command`
// variable bound to the wrong assignment; `E''` escapes hiding a marker; `'net.ht' || 'tp_post'`
// splitting one; `replace(…)` removing one; a CASE manufacturing one; `format(…)::jsonb ->> 'y'`
// evaluating to something else entirely; comments inside `DO $do$` bodies; assignment-like text
// inside a `$cmd$` command literal. Each fix was correct and the next round found the next
// construct — which is the signal to change the design, not to add a tenth special case.
//
// The classification does not need a static approximation. `clone_source_inventory.sql` applies
// the same lexical test to the LIVE `cron.job.command`, and run-rollout.sh compares that against
// this register, failing closed on "CLASSIFICATION DRIFT". Both sides are lexical — neither
// evaluates reachability — but only one of them is reading the command production will actually
// execute. Duplicating it from migration text added surface area without adding safety.
//
// So this file verifies one thing: that every job name any migration schedules is registered.
// Extracting the NAME is a much smaller problem than extracting the command — it is the first
// argument and a quoted literal in every form used here, and where it is not, this fails loudly
// rather than guessing.
//
// IT IS BEST-EFFORT, NOT A PROOF. The same open-ended-construct problem exists here in miniature:
// a comment between `cron` and `.schedule` is not matched, and an exotic escape inside a job name
// would be decoded wrongly. Extending the reader to chase those is the loop this file just came
// out of, so it does not. Its job is to catch the ordinary case — a new migration scheduling a new
// job — on the day it lands, and the live inventory remains the authority for what is really
// there.
//
// One deliberate imprecision, in the safe direction: a commented-out `cron.schedule('x', …)` still
// requires an entry for `x`. Over-registering costs a line in a TSV; under-registering aborts a
// production rollout.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');
const TSV = join(process.cwd(), 'scripts', 'rollout', 'notif-10ca3', 'clone-safety', 'reviewed-cron-jobs.tsv');

/**
 * Every way this repo can reach pg_cron's scheduling API. `cron.schedule(` alone was too narrow:
 * `cron.schedule_in_database(...)` (which the repo's own sanitizer already treats as a clone
 * hazard), a quoted identifier, whitespace around the dot, or a comment between the name and the
 * paren were all invisible — and a job introduced through one of them passed unnoticed.
 */
export const SCHEDULING_CALL =
  /(?:"?cron"?\s*\.\s*"?(schedule_in_database|schedule|unschedule)"?)\s*(?:--[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*\(/gi;

const migrationFiles = () => readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();

/**
 * The first argument of the call whose '(' is at `openParen`. Respects nested parens,
 * single-quoted strings (with '' escapes) and dollar-quoted blocks, so a command containing
 * commas or parentheses cannot make this read the wrong argument. Null if the call is unbalanced.
 */
export function firstArg(sql: string, openParen: number): string | null {
  let depth = 0, i = openParen;
  const start = openParen + 1;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === '$') {
      const tag = sql.slice(i).match(/^\$[A-Za-z_]*\$/);
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        if (end < 0) return null;
        i = end + tag[0].length;
        continue;
      }
    }
    if (ch === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        if (sql[i] === '\\') { i += 2; continue; }
        i++;
      }
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return sql.slice(start, i); }
    else if (ch === ',' && depth === 1) return sql.slice(start, i);
    i++;
  }
  return null;
}

/**
 * A job NAME: the WHOLE argument must be one single-quoted literal. A dynamic or computed name
 * cannot be reconciled against a static register at all, so anything else returns null — and the
 * caller reports it rather than skipping it.
 */
export function jobName(arg: string): string | null {
  const t = arg.trim();
  if (!/^E?'/.test(t)) return null;
  let i = t[0] === 'E' ? 2 : 1;
  let out = '';
  while (i < t.length) {
    if (t[i] === "'" && t[i + 1] === "'") { out += "'"; i += 2; continue; }
    if (t[i] === "'") { i++; break; }
    if (t[i] === '\\' && t[0] === 'E') { out += t[i + 1]; i += 2; continue; }
    out += t[i]; i++;
  }
  return t.slice(i).trim() === '' && out !== '' ? out : null;
}

/** Job names scheduled by one migration, plus anything unreadable. */
export function scanMigration(file: string, sql: string) {
  const found: string[] = [];
  const unreadable: string[] = [];
  for (const m of sql.matchAll(SCHEDULING_CALL)) {
    const kind = m[1].toLowerCase();
    const arg = firstArg(sql, m.index! + m[0].length - 1);
    if (arg === null) { unreadable.push(`${file}: unbalanced cron.${kind}( call`); continue; }
    const name = jobName(arg);
    if (name === null) {
      unreadable.push(`${file}: cron.${kind}() with a NON-LITERAL job name: ${arg.trim().slice(0, 60)}`);
      continue;
    }
    if (kind !== 'unschedule') found.push(name);
  }
  return { names: found, unreadable };
}

const reviewed = (() => {
  const rows = readFileSync(TSV, 'utf8').split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => l.split('\t'));
  return new Map(rows.map((r) => [r[0], { outbound: r[1], note: r[2] ?? '' }]));
})();

const { names, unreadable } = (() => {
  const all: string[] = [];
  const bad: string[] = [];
  for (const file of migrationFiles()) {
    const r = scanMigration(file, readFileSync(join(MIGRATIONS, file), 'utf8'));
    all.push(...r.names);
    bad.push(...r.unreadable);
  }
  return { names: [...new Set(all)], unreadable: bad };
})();

describe('H — the clone-safety cron register covers every scheduled job', () => {
  // A form this cannot read is a HOLE, not a pass.
  it('every scheduling call in the migrations has a readable job name', () => {
    expect(unreadable).toEqual([]);
  });

  // Jobs a migration schedules that are deliberately NOT expected in production.
  // Adding a name here means "retired — a clone will not see it", and it carries its reason.
  const RETIRED = new Map<string, string>([
    ['notify-rebook-member-open',
      'D7 runtime cutover. `20261118115000_d7_runtime_crons.sql` unschedules it, and it sorts '
      + 'BEFORE ABC-27 on purpose: ABC-27 revokes `service_role` EXECUTE on the first RPC this job '
      + 'calls, so an armed job would 500 on a 42501 every 15 minutes forever. The edge function is '
      + 'deleted too. `20260722100000_rebook_crons_use_vault.sql` still SCHEDULES it — migrations '
      + 'are immutable — which is exactly why this map exists rather than a TSV row: a clone taken '
      + 'after the cutover will not see the job, so registering it as a live outbound job would '
      + 'make the quiesce procedure hunt for something that is not there.'],
  ]);

  it('every job any migration schedules is in reviewed-cron-jobs.tsv', () => {
    // NOT "every job the migrations LEAVE scheduled". Three registered jobs
    // (enrich-locations-background, fetch-location-logos-background, invoice-health-check-daily)
    // have an unschedule as their last migration operation because they are re-created at RUNTIME
    // by a scheduler function — they are live in production and must stay registered. Exempting
    // them on final state left their entries freely deletable.
    const missing = names.filter((n) => !RETIRED.has(n) && !reviewed.has(n));
    expect(missing, 'run-rollout.sh aborts the rollout on an unreviewed cron job, before it changes anything — add these to clone-safety/reviewed-cron-jobs.tsv with their outbound classification').toEqual([]);
  });

  it('the register has no entry for a job nothing schedules', () => {
    // A stale entry is a smaller problem than a missing one, but it is how the file drifts from
    // the reality a reader trusts it to describe.
    const orphaned = [...reviewed.keys()].filter((n) => !names.includes(n));
    expect(orphaned).toEqual([]);
  });

  it('the digest cron is registered, outbound, and marked as shipping inactive', () => {
    const entry = reviewed.get('notification-digest-worker');
    expect(entry, 'notification-digest-worker must be in the reviewed cron set').toBeTruthy();
    expect(entry!.outbound).toBe('yes');
    expect(entry!.note).toMatch(/INACTIVE/i);
  });

  it('every entry carries a classification the rollout can compare against', () => {
    // The VALUE is verified at rollout time against the live command. What this can check is that
    // every row is well-formed, so that comparison has something to compare.
    const bad = [...reviewed.entries()]
      .filter(([, e]) => e.outbound !== 'yes' && e.outbound !== 'no')
      .map(([n, e]) => `${n}: outbound='${e.outbound}'`);
    expect(bad).toEqual([]);
  });
});

describe('H — the name reader cannot be fooled', () => {
  it('reads the job name past a command containing commas and parens', () => {
    const sql = `PERFORM cron.schedule('j', '* * * * *', $c$SELECT f(1, 2), g('a,b');$c$);`;
    expect(scanMigration('x.sql', sql).names).toEqual(['j']);
  });

  it('sees the scheduling forms this repo uses, including schedule_in_database', () => {
    for (const call of [
      `SELECT cron.schedule('a', '* * * * *', $c$SELECT 1;$c$);`,
      `SELECT cron.schedule_in_database('b', '* * * * *', $c$SELECT 1;$c$, 'postgres');`,
      `SELECT "cron"."schedule"('c', '* * * * *', $c$SELECT 1;$c$);`,
      `SELECT cron . schedule('d', '* * * * *', $c$SELECT 1;$c$);`,
      `SELECT cron.schedule /* note */ ('e', '* * * * *', $c$SELECT 1;$c$);`,
    ]) {
      const r = scanMigration('x.sql', call);
      expect(r.unreadable, call).toEqual([]);
      expect(r.names, call).toHaveLength(1);
    }
  });

  it('an unschedule does NOT register a job', () => {
    expect(scanMigration('x.sql', `SELECT cron.unschedule('gone');`).names).toEqual([]);
  });

  it('FAILS LOUDLY on a dynamic job name instead of skipping it', () => {
    const r = scanMigration('x.sql', `PERFORM cron.schedule(v_job_name, '* * * * *', $c$SELECT 1;$c$);`);
    expect(r.names).toEqual([]);
    expect(r.unreadable[0]).toMatch(/NON-LITERAL job name/);
  });

  it('does not mistake an expression that merely STARTS with a quote for a name', () => {
    const r = scanMigration('x.sql', `PERFORM cron.schedule('pre' || v_suffix, '* * * * *', $c$SELECT 1;$c$);`);
    expect(r.names).toEqual([]);
    expect(r.unreadable[0]).toMatch(/NON-LITERAL job name/);
  });

  it('decodes doubled quotes inside a job name', () => {
    expect(scanMigration('x.sql', `SELECT cron.schedule('it''s', '* * * * *', $c$SELECT 1;$c$);`).names)
      .toEqual(["it's"]);
  });

  it('a job name inside a DO $do$ body is found like any other', () => {
    const sql = [
      'DO $do$', 'BEGIN',
      `  PERFORM cron.schedule('inside-a-body', '* * * * *', $c$SELECT net.http_post(url := 'u'); -- note$c$);`,
      'END $do$;', '',
    ].join('\n');
    expect(scanMigration('x.sql', sql).names).toEqual(['inside-a-body']);
  });
});
