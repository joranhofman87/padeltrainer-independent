import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { CAPPABLE_EVENTS } from '@/lib/academyNotificationCappable';
import { resolve } from 'node:path';

/**
 * N3 M5 — the attribution matrix's drift pins (design-contract finding 2).
 *
 * `docs/NOTIFICATION_ATTRIBUTION_MATRIX.md` claims, per producer, exactly which tenant
 * attribution reaches `enqueue_notification` — and every cap surface leans on those claims
 * ("a cap on open_slots_player affects nothing today" is only true while notify-followers stays
 * trainer-only). A doc nothing enforces rots into a lie; these pins fail when a producer's
 * attribution changes, forcing the matrix (and the M6 surfaces reading it) to be updated in the
 * same change.
 */

const ROOT = resolve(__dirname, '..', '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

describe('attribution matrix pins', () => {
  it('row 1 — the booking RPC derives BOTH tenants from the booked slots, refusing incoherent sets', () => {
    const src = read('supabase/migrations/20260926100000_booking_notification_enqueue_rpc.sql');
    expect(src).toContain('JOIN public.availability_slots s ON s.id = b.slot_id');
    expect(src).toContain("RAISE EXCEPTION 'enqueue_booking_notification: booking set spans multiple academy scopes'");
    // both call sites supply both tenants
    const supplies = src.match(/p_tenant_academy_profile_id => v_academy/g) ?? [];
    expect(supplies.length).toBeGreaterThanOrEqual(2);
  });

  it('row 2 — booking-confirmation supplies academy + trainer', () => {
    const src = read('supabase/functions/_shared/booking-confirmation-email.ts');
    expect(src).toContain('p_tenant_academy_profile_id: academyProfileId');
    expect(src).toContain('p_tenant_trainer_id: trainerId');
  });

  it('row 3 — mollie staff fan-out supplies the per-recipient staff scope', () => {
    const src = read('supabase/functions/_shared/mollie-booking-paid-side-effects.ts');
    expect(src).toContain('p_tenant_academy_profile_id: scope.academy ?? null');
    expect(src).toContain('p_tenant_trainer_id: scope.trainer ?? null');
  });

  it('row 4 — open_slots_player is TRAINER-ONLY: no academy attribution exists to cap', () => {
    const src = read('supabase/functions/notify-followers/index.ts');
    expect(src).toContain('p_tenant_trainer_id: trainerId');
    // The claim every cap surface depends on: if someone adds academy attribution here, the
    // matrix row and the M6 "affects nothing today" copy are BOTH wrong — fail until updated.
    expect(src).not.toContain('p_tenant_academy_profile_id');
  });

  it('row 5 — review_received_trainer is trainer-only', () => {
    const src = read('supabase/migrations/20260913100000_notification_pilot_review_received.sql');
    expect(src).toContain('p_tenant_trainer_id   => NEW.trainer_id');
    expect(src).not.toContain('p_tenant_academy_profile_id');
  });

  it('the producer inventory is CLOSED: exactly these files call enqueue_notification', () => {
    // A new producer must join the matrix and these pins in the same change. This walks the two
    // trees that can hold callers and asserts the known set — a sixth caller fails here first.
    // CALL SITES, not mentions: N4/N5 migrations describe the resolver in comments and function
    // COMMENTs (the preview mirrors it, the boundary explains what it writes), and a pin that
    // counted prose would fail for a docstring while missing a caller hidden in a one-liner.
    const mentions = execSync(
      `grep -rl "enqueue_notification\\|enqueue_booking_notification" supabase/functions supabase/migrations`,
      { cwd: ROOT, encoding: 'utf8' },
    ).trim().split('\n');
    // WHOLE-FILE, not line-by-line: the ordinary multiline shape
    //   supabase.rpc(
    //     "enqueue_notification",
    //     args,
    //   )
    // contains the call on no single line, and a line-based scan would drop a real producer while
    // still looking strict. Comments are stripped first — prose about the resolver is not a call.
    const stripComments = (src: string) => src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n')
      .map((l) => l.replace(/(^|\s)--\s.*$/, '').replace(/(^|\s)\/\/.*$/, ''))
      .filter((l) => !/^\s*[*]/.test(l))
      .join('\n');
    const callsResolver = (src: string) => {
      const code = stripComments(src)
        // a DEFINITION is not a call — the resolver-defining migrations name it after CREATE
        .replace(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\.(enqueue_notification|enqueue_booking_notification)\s*\(/gi, ' <definition> (');
      return /\brpc\s*\(\s*["'](enqueue_notification|enqueue_booking_notification)["']/s.test(code)
          || /(SELECT|PERFORM)\s+(public\.)?(enqueue_notification|enqueue_booking_notification)\s*\(/is.test(code)
          || /\bFROM\s+(public\.)?(enqueue_notification|enqueue_booking_notification)\s*\(/is.test(code);
    };
    const out = mentions
      .filter((f) => !/\.test\./.test(f))
      .filter((f) => callsResolver(read(f)))
      // the resolver-definition migrations CALL it only to redefine/replay it — and 20261104100000
      // re-defines the two SQL PRODUCERS as well, to give them the occurrence argument. Neither
      // adds a producer; the pin below is what holds them to the contract.
      .filter((f) => !/20260911|20260922|20261011100000|20261011110000|20261015100000|20261015120000|20261104100000|20261106100000|20261108100000/.test(f))
      .sort();
    expect(out).toEqual([
      'supabase/functions/_shared/booking-confirmation-email.ts',
      'supabase/functions/_shared/mollie-booking-paid-side-effects.ts',
      'supabase/functions/notify-followers/index.ts',
      'supabase/migrations/20260913100000_notification_pilot_review_received.sql',
      'supabase/migrations/20260926100000_booking_notification_enqueue_rpc.sql',
      // U2 identity continuity: the resolver enqueues the (inert) address-control challenge. A
      // genuine new producer — it dates the event with now() (the submission just happened) and is
      // asserted to carry p_occurred_at below.
      'supabase/migrations/20261129100000_u2_identity_verification.sql',
    ]);
  });

  it('EVERY producer declares when the event occurred — no call site relies on the default', () => {
    // The final audit's second round: the activation boundary measures `occurred_at`, and a
    // producer that omits it gets "whenever this row was written", which for a retried or
    // redelivered producer is exactly the historical event the boundary exists to refuse. This
    // walks the same closed inventory as the pin above and requires the argument at every site.
    //
    // The newest definition of each SQL producer lives in the audit migration, so that is where
    // those two are checked — grepping the superseded original would pass on dead text.
    const sites: Array<[string, RegExp]> = [
      ['supabase/functions/_shared/booking-confirmation-email.ts', /p_occurred_at:\s*occurredAt/],
      ['supabase/functions/_shared/mollie-booking-paid-side-effects.ts', /p_occurred_at:\s*occurredAt/],
      ['supabase/functions/notify-followers/index.ts', /p_occurred_at:\s*occurredAt/],
    ];
    for (const [file, pattern] of sites) {
      const src = read(file);
      // the window grew when the producers gained p_occurred_at and the transition discriminator;
      // a fixed 900 chars silently matched ZERO calls in the staff producer and the pin passed
      // vacuously, which is the failure mode a call-site guard exists to avoid
      const calls = src.match(/rpc\(\s*["']enqueue_notification["'][\s\S]{0,1600}?\n\s*\}\);/g) ?? [];
      expect(calls.length, `${file}: no enqueue_notification call found`).toBeGreaterThan(0);
      for (const call of calls) expect(call, `${file}: a call site omits p_occurred_at`).toMatch(pattern);
    }
    // …and the two in-database producers, in the migration that owns their current definition
    // BOTH audit migrations: the round-2 one re-lifts enqueue_booking_notification to date its
    // transitions correctly, so it is the newest definition of that producer.
    // every audit migration that re-lifts a SQL producer; 20261108100000 is the newest, moving
    // both arms onto the booking lifecycle ledger
    const mig = ['20261104100000_notif_audit_event_occurrence_boundary.sql',
                 '20261106100000_notif_audit_occurrence_is_the_transition.sql',
                 '20261108100000_booking_lifecycle_events.sql']
      .map((f) => read('supabase/migrations/' + f)).join('\n');
    const sqlCalls = mig.match(/public\.enqueue_notification\(\s*[\s\S]{0,1400}?\n\s*\);/g) ?? [];
    expect(sqlCalls.length, 'the audit migrations should carry the SQL producers').toBe(7);
    for (const call of sqlCalls) expect(call).toMatch(/p_occurred_at\s*=>/);
    // fail closed rather than dating an undateable message with now()
    expect(mig).toMatch(/refusing to enqueue a message we cannot date/);

    // the U2 identity-continuity producer dates its (inert) challenge with now() too — the
    // submission just happened, so there is nothing historical to preserve, but the argument is
    // passed explicitly rather than defaulted.
    const ivMig = read('supabase/migrations/20261129100000_u2_identity_verification.sql');
    const ivIdx = ivMig.indexOf('enqueue_notification(');
    expect(ivIdx, 'the identity-verification producer should call enqueue').toBeGreaterThan(-1);
    expect(ivMig.slice(ivIdx, ivIdx + 1400)).toMatch(/p_occurred_at\s*=>/);
  });

  // open-slots-notify.ts COMPOSES the open_slots_player send but does not call the resolver
  // itself — notify-followers does, and the matrix attributes the row there. Pinned separately so
  // the split is a fact rather than an accident of which file the grep happened to match.
  it('open-slots-notify composes the open_slots_player payload; notify-followers is the caller', () => {
    const composer = read('supabase/functions/_shared/open-slots-notify.ts');
    expect(composer).toContain('open_slots_player');
    expect(composer).not.toMatch(/rpc\(\s*["']enqueue_notification["']/);
    const caller = read('supabase/functions/notify-followers/index.ts');
    expect(caller).toMatch(/rpc\(\s*["']enqueue_notification["']/);
    expect(caller).toContain('p_tenant_trainer_id: trainerId');
  });

  it('the matrix document exists and states the rule', () => {
    const doc = read('docs/NOTIFICATION_ATTRIBUTION_MATRIX.md');
    expect(doc).toContain('iff the producer supplied `p_tenant_academy_profile_id`');
    expect(doc).toContain('NEVER infers an academy');
    expect(doc).toContain('affects nothing today');
  });
});


describe('the UI cappable list stays inside the matrix', () => {
  it('every CAPPABLE_EVENTS entry appears in a matrix row marked cappable', () => {
    const doc = read('docs/NOTIFICATION_ATTRIBUTION_MATRIX.md');
    for (const { event } of CAPPABLE_EVENTS) {
      expect(doc, `${event} missing from the matrix`).toContain(event);
    }
    // and the two trainer-only events must NEVER appear in the UI list — a control for them
    // would be a switch wired to nothing.
    const uiEvents = CAPPABLE_EVENTS.map((e) => e.event);
    expect(uiEvents).not.toContain('open_slots_player');
    expect(uiEvents).not.toContain('review_received_trainer');
    // and no REQUIRED event may be offered (booking_confirmed_player is the live required one)
    expect(uiEvents).not.toContain('booking_confirmed_player');
  });
});
