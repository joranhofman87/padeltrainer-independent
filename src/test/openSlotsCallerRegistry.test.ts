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
    file: 'src/lib/notifyFollowers.ts',
    subtype: 'new_availability',
    reason: 'THE single typed caller. Every invocation funnels through it so the route string '
      + 'exists in exactly one place, which is what makes this register enforceable rather than '
      + 'bypassable by a variable indirection.',
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

/**
 * Any file that reaches the route, however it is spelled.
 *
 * A literal-name matcher alone is bypassable — `const FN = "notify-followers"; invoke(FN)` would
 * sail past it. So this looks for the route STRING anywhere in the file (which a variable
 * indirection still has to contain) as well as the direct invoke/URL forms, and the ownership
 * test below then requires all of it to funnel through one typed caller.
 */
function discoverCallers(): string[] {
  const found: string[] = [];
  for (const rel of REPO_FILES) {
    const src = read(rel);
    if (/["'`]notify-followers["'`]|\/functions\/v1\/notify-followers/.test(src)) {
      found.push(rel);
    }
  }
  return found.sort();
}

/** The single typed caller every invocation must go through. */
const CENTRAL_CALLER = 'src/lib/notifyFollowers.ts';

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

  it('the ONLY file naming the route is the central caller', () => {
    // This is the control finding #6 asked for: ownership, not name-matching. If any other file
    // mentions the route at all — literal invoke, URL, or a `const FN = "notify-followers"` — it
    // shows up here and must be routed through src/lib/notifyFollowers.ts instead.
    expect(discoverCallers()).toEqual([CENTRAL_CALLER]);
  });

  it('the body builder sends STRUCTURED ISO dates, never display text', () => {
    // The component builds the request body and hands it to the central caller. The window starts
    // at the DERIVATION rather than at the call, because the range is now computed a few lines
    // earlier — min/max over the formatted calendar DATES, so that it matches the edge's
    // `min((start_time AT TIME ZONE tz)::date)` across a DST fall-back.
    const src = read('src/components/slots/BulkCreateContent.tsx');
    const from = src.indexOf('const slotDates');
    expect(from, 'BulkCreateContent must derive the range from the returned rows').toBeGreaterThan(-1);
    const at = src.indexOf('notifyFollowers(', from);
    expect(at, 'BulkCreateContent must build its body through the central caller').toBeGreaterThan(-1);
    const body = src.slice(from, at + 900);
    expect(body).toContain('date_from');
    expect(body).toContain('date_to');
    expect(body).toContain('yyyy-MM-dd');
    expect(body, 'the pre-cutover display range must not come back').not.toContain('date_range');
    expect(body).not.toContain('MMM d');
  });

  it('the body builder sends the EXACT PUBLIC slot ids, taken from the INSERT result', () => {
    // C-1 + C-2 in one assertion, because the two failures were the same failure: the client used
    // to hardcode `hasPublicSlots = true` and pass its own pre-insert array, so a wholly-private
    // batch notified followers and `slot_count` counted private slots. Visibility and identity
    // must both come from the rows the DATABASE returned.
    const src = read('src/components/slots/BulkCreateContent.tsx');
    const at = src.indexOf('notifyFollowers(');
    const body = src.slice(at, at + 1400);
    expect(body, 'the exact inserted public ids must be sent').toContain('slot_ids');
    expect(body).toContain('publicSlots.map((s) => s.id)');
    expect(body, 'slot_count must count the PUBLIC rows').toContain('slot_count: publicSlots.length');

    // and `publicSlots` is derived by filtering the RETURNED rows, not the client's input array
    const derivation = src.slice(src.indexOf('const publicSlots'), src.indexOf('const publicSlots') + 200);
    expect(derivation).toContain('insertedSlots.filter');
    expect(derivation).toContain('is_public === true');
    // Line-based, not a substring of the whole file: the comment above the fix QUOTES the old
    // line to explain what went wrong, and a naive `.not.toContain` would match that prose and
    // fail for the wrong reason. Only a real statement counts.
    const hardcoded = src.split('\n')
      .map((l) => l.trim())
      .filter((l) => !l.startsWith('//') && !l.startsWith('*'))
      .filter((l) => /^const hasPublicSlots\s*=\s*true/.test(l));
    expect(hardcoded, 'the hardcoded visibility must not come back').toEqual([]);
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

  it('the legacy dedup ledger is WRITE-ONLY — a claim can never suppress a notification', () => {
    // A `notification_sends` row is a claim taken BEFORE the pre-cutover send, and the old
    // handler deleted it again when the send failed. So a surviving claim means "sent" OR "the
    // invocation died between claiming and sending" — and a deploy is exactly what kills an
    // in-flight invocation. Reading it to skip a recipient would drop that follower AND report
    // the run successful. Recording into it is safe and is the rollback protection, so the
    // asymmetry is the design, and it is pinned here rather than left to a comment.
    const handler = read('supabase/functions/notify-followers/index.ts');
    expect(handler).toContain('from("notification_sends")');
    expect(handler, 'the ledger must never be read back to decide whether to notify')
      .not.toMatch(/notification_sends"\)\s*\n\s*\.select/);
    const mod = read('supabase/functions/_shared/open-slots-notify.ts');
    expect(mod).toContain('export function markableLegacyKeys');
    expect(mod, 'no exported primitive may turn a legacy claim into a skip')
      .not.toMatch(/export function \w*(?:partition|alreadySent|claimed)\w*/i);
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
