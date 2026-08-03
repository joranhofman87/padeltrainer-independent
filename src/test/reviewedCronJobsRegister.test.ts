// @vitest-environment node
// 10c-b H — every cron job a migration schedules must be in the clone-safety reviewed set.
//
// `scripts/rollout/notif-10ca3/run-rollout.sh` FAILS CLOSED on any live cron job that is not in
// `clone-safety/reviewed-cron-jobs.tsv`: "UNREVIEWED cron job present" aborts the clone-source
// quiesce. That is the correct posture — a job added at runtime is exactly what a clone must not
// inherit — but nothing connected it to the migrations, so a slice could add a cron and the gap
// would only surface in front of an operator, mid-rollout, with production paused.
//
// It already happened: 10c-b F scheduled `notification-digest-worker` and it was never registered.
// This is the guard that would have caught it the same day.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');
const TSV = join(process.cwd(), 'scripts', 'rollout', 'notif-10ca3', 'clone-safety', 'reviewed-cron-jobs.tsv');

/** Job names scheduled by a migration, as quoted literals. Dynamic/runtime schedulers (a name
 *  built by a function) cannot be read statically and are registered by hand — the TSV marks
 *  those RUNTIME-SCHEDULED. */
function scheduledInMigrations(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql'))) {
    const sql = readFileSync(join(MIGRATIONS, f), 'utf8');
    for (const m of sql.matchAll(/cron\.schedule\(\s*'([^']+)'/g)) {
      found.set(m[1], [...(found.get(m[1]) ?? []), f]);
    }
  }
  return found;
}

/** Names later removed by an unschedule, so they are not expected to be live. */
function unscheduledInMigrations(): Set<string> {
  const gone = new Set<string>();
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql'))) {
    for (const m of readFileSync(join(MIGRATIONS, f), 'utf8').matchAll(/cron\.unschedule\(\s*'([^']+)'/g)) {
      gone.add(m[1]);
    }
  }
  return gone;
}

const reviewed = (() => {
  const rows = readFileSync(TSV, 'utf8').split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => l.split('\t'));
  return new Map(rows.map((r) => [r[0], { outbound: r[1], note: r[2] ?? '' }]));
})();

describe('H — the clone-safety cron register covers every scheduled job', () => {
  it('every job a migration schedules is in reviewed-cron-jobs.tsv', () => {
    const scheduled = scheduledInMigrations();
    const gone = unscheduledInMigrations();
    const missing = [...scheduled.entries()]
      // A job whose LAST word in the migrations is an unschedule is not expected to be live.
      .filter(([name]) => !gone.has(name) || reviewed.has(name))
      .filter(([name]) => !reviewed.has(name))
      .map(([name, files]) => `${name} (scheduled in ${files.join(', ')})`);
    expect(missing, 'run-rollout.sh aborts the clone-source quiesce on an unreviewed cron job — add these to clone-safety/reviewed-cron-jobs.tsv with their outbound classification').toEqual([]);
  });

  // The classification is what the guard compares against the LIVE command, so a job that posts
  // must be marked as posting. Getting it wrong reads as "CLASSIFICATION DRIFT" mid-rollout.
  it('a job whose command makes an outbound call is classified outbound', () => {
    const outboundCall = /net\.http_(post|get|delete)|http_post|http_get|dblink/i;
    const wrong: string[] = [];
    for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql'))) {
      const sql = readFileSync(join(MIGRATIONS, f), 'utf8');
      for (const m of sql.matchAll(/cron\.schedule\(\s*'([^']+)'\s*,\s*'[^']*'\s*,\s*(\$[a-z]*\$)([\s\S]*?)\2/g)) {
        const [, name, , command] = m;
        const entry = reviewed.get(name);
        if (!entry) continue;                       // the test above owns that case
        const want = outboundCall.test(command) ? 'yes' : 'no';
        if (entry.outbound !== want) {
          wrong.push(`${name}: reviewed='${entry.outbound}' but its command in ${f} is '${want}'`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('the digest cron is registered, and marked as an outbound sender', () => {
    // Named explicitly because it is the one this guard was written for, and because it is the
    // only registered job that ships INACTIVE — a reader of the TSV needs to see that.
    const entry = reviewed.get('notification-digest-worker');
    expect(entry, 'notification-digest-worker must be in the reviewed cron set').toBeTruthy();
    expect(entry!.outbound).toBe('yes');
    expect(entry!.note).toMatch(/INACTIVE/i);
  });
});
