// @vitest-environment node
//
// THE LEGACY send-email REGISTER.
//
// Every remaining route into the legacy `send-email` edge function is declared here with a
// CLASSIFICATION. The test walks the repo, finds the real invocation sites, and fails if the
// two disagree — in either direction:
//
//   * a NEW caller appears           → someone re-entered the legacy path; decide deliberately
//   * a declared caller DISAPPEARS   → the manifest is stale; delete the entry with the PR
//
// This is one structural guard instead of a pin per call site, which is what stops the legacy
// surface growing back silently while the v2 migration finishes. It is deliberately blunt: it
// asserts WHERE the legacy path is reachable from, not what those emails contain.
//
// Classification vocabulary:
//   'migrated'  — no longer here; the v2 outbox owns this event (kept only as a tombstone)
//   'retained'  — still on send-email ON PURPOSE, with a reason and an exit condition
//   'dead'      — the code exists but nothing calls it (proven by the caller-count assertions)
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

type Entry = {
  file: string;
  type: string;
  status: 'retained' | 'migrated';
  /** Why it is still on the legacy path, and what would let it leave. */
  reason: string;
};

/**
 * The register. Adding a row here is a deliberate act — it means "yes, this may call the
 * legacy sender". Removing the last row for a file means that file must no longer call it.
 */
const REGISTER: Entry[] = [
  // ── System / transactional mail that never consulted the v1 preference columns ─────────
  // These are in SYSTEM_EMAIL_TYPES inside send-email, so they do NOT read
  // notification_preferences. They therefore do not block removing the PR 8 v1 bridge, and
  // are retained to keep this PR's blast radius on the preference-gated paths.
  {
    file: 'supabase/functions/send-schedule-notifications/index.ts',
    type: 'schedule_notification',
    status: 'retained',
    reason: 'System email, not v1-preference-gated. No v2 catalog event for schedule digests yet.',
  },
  {
    file: 'supabase/functions/create-manual-player/index.ts',
    type: 'intake_registration_confirmation',
    status: 'retained',
    reason: 'System email, not v1-preference-gated. Intake flow has no v2 catalog event yet.',
  },
  {
    file: 'supabase/functions/_shared/registration-confirmation-email.ts',
    type: 'intake_registration_confirmation',
    status: 'retained',
    reason: 'Same intake confirmation, shared helper. Migrates with the intake event.',
  },
  {
    file: 'supabase/functions/submit-guest-intake/index.ts',
    type: 'new_intake_registration_admin',
    status: 'retained',
    reason: 'System email to staff about a new intake. No v2 catalog event yet.',
  },
  {
    file: 'src/pages/marketing/Partner.tsx',
    type: 'partner_inquiry',
    status: 'retained',
    reason: 'Marketing contact form to the platform inbox. Not a tenant notification; out of the v2 model.',
  },
  // ── v1-PREFERENCE-GATED, still outstanding ────────────────────────────────────────────
  // These DO consult notification_preferences inside send-email, so the PR 8 transitional
  // "Other notifications" bridge cannot be removed until all three are migrated. They are
  // client-side calls, and the client cannot reach enqueue_notification (service-role only),
  // so migrating them means moving the send SERVER-side — which needs care: the paid path
  // already enqueues booking_confirmed_player, so a naive bookings trigger would re-create
  // exactly the double-send just removed from ReviewForm.
  {
    file: 'src/pages/BookLesson.tsx',
    type: 'booking_request + manual_booking_confirmation',
    status: 'retained',
    reason:
      'PENDING MIGRATION. booking_request → booking_request_staff exists in the catalog; '
      + 'manual_booking_confirmation needs a server-side owner that cannot double-fire with '
      + 'the paid-path booking_confirmed_player. Exit: server-side enqueue lands.',
  },
  {
    file: 'src/components/booking/BookForPlayerDialog.tsx',
    type: 'manual_booking_confirmation',
    status: 'retained',
    reason:
      'PENDING MIGRATION. Staff booking on a player\'s behalf; same server-side owner as '
      + 'BookLesson\'s manual confirmation. Exit: server-side enqueue lands.',
  },
  {
    file: 'supabase/functions/notify-followers/index.ts',
    type: 'new_availability / slot_reopened',
    status: 'retained',
    reason:
      'PENDING MIGRATION. No v2 catalog event exists for open-slot alerts, so this needs a '
      + 'new event type before it can move. Its v1 preference filter is ALSO broken today: it '
      + 'selects notification_preferences.email_new_availability, a column that does not '
      + 'exist, and discards the error — so the global opt-out is inert. Exit: new catalog '
      + 'event + rewrite.',
  },
  {
    file: 'src/lib/email.ts',
    type: '(dynamic)',
    status: 'retained',
    reason:
      'The generic sendEmail() wrapper. Still used by invitation + club-claim system mail '
      + '(club_trainer_invitation, academy_trainer_invitation, *_accepted, club_claim_*), '
      + 'none of which are v1-preference-gated.',
  },
];

/** Files that MUST NOT contain a send-email invocation any more (migration tombstones). */
const MIGRATED_AWAY: Array<{ file: string; type: string; to: string }> = [
  { file: 'src/components/reviews/ReviewForm.tsx', type: 'review_received', to: 'review_received_trainer (trg_notify_review_received)' },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const ROOT = process.cwd();
const INVOKE = /invoke\(\s*["']send-email["']|\/functions\/v1\/send-email/;

/** Every file that reaches the legacy sender, excluding the function itself and tests. */
function liveCallerFiles(): string[] {
  const files = [...walk(join(ROOT, 'supabase')), ...walk(join(ROOT, 'src'))]
    .map((p) => p.slice(ROOT.length + 1).split('\\').join('/'));
  return files.filter((rel) => {
    if (rel.startsWith('supabase/functions/send-email/')) return false;
    if (rel.includes('/test/') || rel.includes('.test.')) return false;
    return INVOKE.test(readFileSync(join(ROOT, rel), 'utf8'));
  }).sort();
}

describe('the legacy send-email register', () => {
  it('matches the real call sites EXACTLY — no undeclared caller, no stale entry', () => {
    const actual = liveCallerFiles();
    const declared = [...new Set(REGISTER.map((e) => e.file))].sort();

    const undeclared = actual.filter((f) => !declared.includes(f));
    const stale = declared.filter((f) => !actual.includes(f));

    expect(
      undeclared,
      'A NEW legacy send-email caller appeared. The v2 outbox is the supported path — '
      + 'migrate it, or add it to REGISTER with a reason and an exit condition.',
    ).toEqual([]);
    expect(
      stale,
      'A declared legacy caller no longer exists. Delete its REGISTER row in the same PR '
      + 'so the register never overstates what is left.',
    ).toEqual([]);
  });

  it('every retained entry carries a real reason', () => {
    // A register whose reasons are blank is just a list, and a list nobody can argue with
    // is how "temporary" becomes permanent.
    for (const e of REGISTER) {
      expect(e.reason.length, `${e.file} (${e.type}) needs a reason`).toBeGreaterThan(30);
    }
  });

  it('files migrated OFF the legacy path never call it again', () => {
    for (const { file, to } of MIGRATED_AWAY) {
      const src = readFileSync(join(ROOT, file), 'utf8');
      expect(INVOKE.test(src), `${file} was migrated to ${to} — it must not call send-email again`).toBe(false);
    }
  });
});

describe('the review notification is enqueued once, server-side', () => {
  // A DOUBLE-SEND that was invisible until PR 10a made the outbox actually deliver: the PR 5
  // pilot trigger enqueues review_received_trainer on INSERT, and ReviewForm ALSO called the
  // legacy sender. Both fired for every review.
  it('the pilot trigger still owns it', () => {
    const mig = readFileSync(join(ROOT, 'supabase/migrations/20260913100000_notification_pilot_review_received.sql'), 'utf8');
    expect(mig).toMatch(/CREATE TRIGGER trg_notify_review_received/);
    expect(mig).toMatch(/'review_received_trainer'/);
  });

  it('the client no longer sends its own copy', () => {
    const form = readFileSync(join(ROOT, 'src/components/reviews/ReviewForm.tsx'), 'utf8');
    expect(form).not.toMatch(/sendReviewNotification/);
  });

  it('and the now-callerless wrapper is gone from lib/email', () => {
    const lib = readFileSync(join(ROOT, 'src/lib/email.ts'), 'utf8');
    expect(lib).not.toMatch(/export const sendReviewNotification/);
  });
});
