// 10c-b D — the DURABLE caller registry for notify-followers.
//
// Why this exists: slice D discovered the caller set by grep, and two of the three things it
// found were wrong in the repo's own documentation — a clone-safety TSV claimed a cron job
// invoked this function when it does not, and the `slot_reopened` branch turned out to have no
// invoker at all. A one-off grep during a migration is not a control; the next person to add a
// caller has nothing to fail. This register makes the caller set an ASSERTED fact.
//
// It also pins the thing D actually cut over: every invoker must send STRUCTURED ISO dates.
// A display-formatted range would be frozen, unparseable, into an immutable hash-covered digest
// item, and would change the event identity whenever the format changed.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { eventSubject, parseNotifyRequest } from '../../supabase/functions/_shared/open-slots-notify';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/**
 * Every place allowed to invoke notify-followers, with the subtype it drives.
 * Adding an invoker without adding a row here fails the first test below.
 */
const CALLERS = [
  {
    file: 'src/components/slots/BulkCreateContent.tsx',
    subtype: 'new_availability',
    reason: 'Trainer self-service bulk slot generation. Gated by shouldInvokeNotifyFollowersOnBulkGenerate '
      + 'because academy managers have no trainer_profiles row and the function resolves trainer identity '
      + 'from the authenticated user.',
  },
] as const;

/**
 * `slot_reopened` has NO invoker. Recorded deliberately rather than silently: the capability is
 * retained (the SQL renderer and the request parser both support it, and it is reachable by a
 * direct function invoke), but nothing in this repo drives it today. If a caller is added, move
 * it into CALLERS above.
 */
const UNINVOKED_SUBTYPES = ['slot_reopened'] as const;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const REPO_FILES = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'supabase'))]
  .map((p) => p.slice(ROOT.length + 1).split('\\').join('/'))
  .filter((rel) => !rel.startsWith('supabase/functions/notify-followers/')
    && !rel.includes('/test/') && !rel.includes('.test.'));

/** Any route that reaches the function, however it is spelled. */
function discoverCallers(): string[] {
  const found: string[] = [];
  for (const rel of REPO_FILES) {
    const src = read(rel);
    if (/invoke\(\s*["']notify-followers["']|\/functions\/v1\/notify-followers/.test(src)) {
      found.push(rel);
    }
  }
  return found.sort();
}

describe('the notify-followers caller registry', () => {
  it('matches the real invoker set exactly', () => {
    const actual = discoverCallers();
    // CALLERS is `as const`, so `.map(c => c.file)` yields a literal-typed array and
    // `.includes(someString)` is a TS2345. Widen deliberately — the register compares paths.
    const declared: string[] = CALLERS.map((c) => c.file as string).sort();

    expect(
      actual.filter((f) => !declared.includes(f)),
      'A new notify-followers caller is not registered. Add it to CALLERS with the subtype it '
      + 'drives and why — and make sure it sends structured ISO dates.',
    ).toEqual([]);
    expect(
      declared.filter((f) => !actual.includes(f)),
      'A registered caller no longer invokes notify-followers — delete its row so the register '
      + 'never overstates the caller set.',
    ).toEqual([]);
  });

  it('every registered caller sends STRUCTURED ISO dates, never display text', () => {
    for (const c of CALLERS) {
      const src = read(c.file);
      // Anchor on the INVOCATION, not the first textual mention — a comment above the call
      // would otherwise shift the window off the request body and make this vacuous.
      const at = src.search(/invoke\(\s*["']notify-followers["']|\/functions\/v1\/notify-followers/);
      expect(at, `${c.file} must actually invoke notify-followers`).toBeGreaterThan(-1);
      const body = src.slice(at, at + 900);
      if (c.subtype === 'new_availability') {
        expect(body, `${c.file} must send date_from`).toContain('date_from');
        expect(body, `${c.file} must send date_to`).toContain('date_to');
        expect(body, `${c.file} must use yyyy-MM-dd`).toContain('yyyy-MM-dd');
      }
      // the pre-cutover display range must not come back
      expect(body, `${c.file} must not send a display date_range`).not.toContain('date_range');
      expect(body, `${c.file} must not format dates for display in the request`).not.toContain('MMM d');
    }
  });

  it('every registered caller carries a real reason', () => {
    for (const c of CALLERS) {
      expect(c.reason.length, `${c.file} needs a reason`).toBeGreaterThan(40);
    }
  });

  it('records the subtypes that currently have no invoker', () => {
    // A guard against quietly "retiring" a supported subtype by attrition: if someone adds a
    // slot_reopened caller, this must be updated deliberately.
    expect(UNINVOKED_SUBTYPES).toEqual(['slot_reopened']);
    // ...and the capability is genuinely still SUPPORTED — proven by EXECUTING the production
    // parser, not by grepping for the word, which a comment or a dead type would satisfy.
    const parsed = parseNotifyRequest({
      slot_count: 1, single_slot: { date: '2026-08-10', time: '18:30' },
      booking_id: '11111111-1111-4111-8111-111111111111',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.req.subtype).toBe('slot_reopened');
    expect(eventSubject(parsed.req, 'trainer-1')).toContain('sr:trainer-1:');
  });

  it('the clone-safety cron inventory does not attribute this function to a cron job', () => {
    // scripts/rollout/notif-10ca3/clone-safety/reviewed-cron-jobs.tsv claimed
    // notify-rebook-member-open "invokes the notify-followers edge function". It does not — it
    // sends its own mail through Resend. That review evidence is load-bearing for the clone
    // quiesce, so pin the correction rather than trusting it to stay fixed.
    const tsv = read('scripts/rollout/notif-10ca3/clone-safety/reviewed-cron-jobs.tsv');
    expect(tsv).not.toContain('invokes the notify-followers edge function');
    const fn = read('supabase/functions/notify-rebook-member-open/index.ts');
    expect(fn).not.toContain('notify-followers');
  });
});
