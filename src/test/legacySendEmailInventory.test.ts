// @vitest-environment node
//
// THE LEGACY send-email REGISTER.
//
// Every remaining ROUTE into the legacy `send-email` edge function is declared here with a
// classification. The test discovers the real routes and fails if reality and the register
// disagree in EITHER direction:
//
//   * a NEW route appears        → someone re-entered the legacy path; decide deliberately
//   * a declared route VANISHES  → the register is stale; delete the row in the same PR
//
// WHY THIS IS ROUTE-BASED, NOT FILE-BASED
// ---------------------------------------
// The first version of this guard scanned for files CONTAINING a send-email invocation. That
// measured the wrong thing and missed a whole class: `DeleteSlotDialog` sends
// `booking_cancelled` by calling the `sendBookingCancellation()` wrapper in lib/email.ts, so
// it contains no send-email text at all and the guard reported it as clean. A register that
// can silently miss a preference-gated caller is worse than none — it was used to claim the
// v1 bridge was nearly removable when it was not.
//
// So discovery now covers all four ways to reach the legacy sender:
//   1. supabase.functions.invoke("send-email", …)
//   2. fetch(`…/functions/v1/send-email`, …)
//   3. sendEmail("<type>", …)                — the generic wrapper
//   4. <namedWrapper>(…)                     — wrappers are DERIVED from lib/email.ts, not
//                                              hardcoded, so a NEW wrapper is covered the
//                                              moment it exists
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

type Route = { file: string; type: string };
type Entry = Route & {
  status: 'retained' | 'pending';
  /** Why it is still on the legacy path, and what would let it leave. */
  reason: string;
};

const REGISTER: Entry[] = [
  // ── System mail: NOT v1-preference-gated (SYSTEM_EMAIL_TYPES in send-email) ────────────
  // These never read notification_preferences, so they do not block removing the PR 8
  // transitional bridge. Retained to keep this PR's blast radius on the gated paths.
  { file: 'supabase/functions/send-schedule-notifications/index.ts', type: 'schedule_notification',
    status: 'retained', reason: 'System email, not v1-preference-gated. No v2 catalog event for schedule digests yet.' },
  { file: 'supabase/functions/create-manual-player/index.ts', type: 'intake_registration_confirmation',
    status: 'retained', reason: 'System email, not v1-preference-gated. Intake flow has no v2 catalog event yet.' },
  { file: 'supabase/functions/_shared/registration-confirmation-email.ts', type: 'intake_registration_confirmation',
    status: 'retained', reason: 'Same intake confirmation, shared helper. Migrates with the intake event.' },
  { file: 'supabase/functions/submit-guest-intake/index.ts', type: 'new_intake_registration_admin',
    status: 'retained', reason: 'System email to staff about a new intake. No v2 catalog event yet.' },
  { file: 'src/pages/marketing/Partner.tsx', type: 'partner_inquiry',
    status: 'retained', reason: 'Marketing contact form to the platform inbox. Not a tenant notification; outside the v2 model.' },
  { file: 'src/components/club/InviteClubTrainerDialog.tsx', type: 'club_trainer_invitation',
    status: 'retained', reason: 'Invitation system mail, not v1-preference-gated. No v2 catalog event for invitations yet.' },
  { file: 'src/components/academy/InviteAcademyTrainerDialog.tsx', type: 'academy_trainer_invitation',
    status: 'retained', reason: 'Invitation system mail, not v1-preference-gated. No v2 catalog event for invitations yet.' },
  { file: 'src/pages/club/ClubTrainerInvitation.tsx', type: 'club_trainer_invitation_accepted',
    status: 'retained', reason: 'Invitation-accepted system mail, not v1-preference-gated. Migrates with invitations.' },
  { file: 'src/pages/academy/AcademyTrainerInvitation.tsx', type: 'academy_trainer_invitation_accepted',
    status: 'retained', reason: 'Invitation-accepted system mail, not v1-preference-gated. Migrates with invitations.' },
  { file: 'src/pages/admin/AdminClubClaims.tsx', type: 'club_claim_approved',
    status: 'retained', reason: 'Platform-admin club claim decision. System mail, not v1-preference-gated.' },
  { file: 'src/pages/admin/AdminClubClaims.tsx', type: 'club_claim_rejected',
    status: 'retained', reason: 'Platform-admin club claim decision. System mail, not v1-preference-gated.' },

  // ── v1-PREFERENCE-GATED: these BLOCK removal of the PR 8 "Other notifications" bridge ──
  // send-email maps each of these to a notification_preferences column, so the v1 settings
  // remain load-bearing until every one has moved.
  //
  // EMPTY as of 10c-b D: notify-followers — the last one — moved to
  // enqueue_notification('open_slots_player'). See MIGRATED_AWAY below.
];

/** Wrappers that MUST no longer exist — dead code removed, kept as tombstones. */
const REMOVED_WRAPPERS = ['sendReviewNotification', 'sendBookingConfirmation', 'sendBookingCancellation'];

/** Files that must never call the legacy sender again (by any route). */
const MIGRATED_AWAY = [
  { file: 'src/components/reviews/ReviewForm.tsx', to: 'review_received_trainer (trg_notify_review_received)' },
  { file: 'src/pages/BookLesson.tsx', to: 'enqueue_booking_notification(request_staff | confirmation_player)' },
  { file: 'src/components/booking/BookForPlayerDialog.tsx', to: 'enqueue_booking_notification(confirmation_player), one call per recipient' },
  { file: 'src/components/slots/DeleteSlotDialog.tsx', to: 'enqueue_booking_notification(cancelled_player), complete cancelled set' },
  { file: 'supabase/functions/notify-followers/index.ts', to: "enqueue_notification('open_slots_player'), both subtypes; notification_sends dedup replaced by the resolver's idempotency key" },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const REPO_FILES = [...walk(join(ROOT, 'supabase')), ...walk(join(ROOT, 'src'))]
  .map((p) => p.slice(ROOT.length + 1).split('\\').join('/'))
  .filter((rel) => !rel.startsWith('supabase/functions/send-email/')
    && !rel.includes('/test/') && !rel.includes('.test.'));

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/**
 * Named wrappers are DERIVED from lib/email.ts rather than listed, so a wrapper added
 * tomorrow is inventoried automatically instead of quietly bypassing this guard.
 */
function namedWrappers(): Record<string, string> {
  const lib = read('src/lib/email.ts');
  const out: Record<string, string> = {};
  for (const m of lib.matchAll(/export const (\w+)\s*=\s*async[\s\S]{0,900}?sendEmail\(\s*["']([a-z_]+)["']/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

/** Every semantic route into the legacy sender, however it is reached. */
function discoverRoutes(): Route[] {
  const wrappers = namedWrappers();
  const routes: Route[] = [];
  const push = (file: string, type: string) => {
    if (!routes.some((r) => r.file === file && r.type === type)) routes.push({ file, type });
  };

  for (const rel of REPO_FILES) {
    const src = read(rel);

    // 1 + 2: direct invocation — take the `type:` literal from the call body.
    const direct = [...src.matchAll(/invoke\(\s*["']send-email["']|\/functions\/v1\/send-email/g)];
    for (const m of direct) {
      const window = src.slice(m.index!, m.index! + 700);
      const t = window.match(/type:\s*["']([a-z_]+)["']/);
      const dyn = window.match(/type:\s*([A-Za-z_][\w.]*)/);
      if (rel === 'src/lib/email.ts') continue;           // the wrapper itself, covered via 3/4
      push(rel, t ? t[1] : dyn ? `(dynamic:${dyn[1]})` : '(unknown)');
    }

    // 3: generic wrapper with a literal type
    for (const m of src.matchAll(/sendEmail\(\s*["']([a-z_]+)["']/g)) {
      if (rel === 'src/lib/email.ts') continue;
      push(rel, m[1]);
    }

    // 4: named wrappers (derived) — the class the file-based guard missed entirely
    for (const [fn, type] of Object.entries(wrappers)) {
      if (rel === 'src/lib/email.ts') continue;
      if (new RegExp(`\\b${fn}\\s*\\(`).test(src)) push(rel, type);
    }
  }
  return routes;
}

const key = (r: Route) => `${r.file} :: ${r.type}`;

describe('the legacy send-email register', () => {
  it('matches the real ROUTES exactly — wrapper calls included', () => {
    const actual = discoverRoutes().map(key).sort();
    const declared = REGISTER.map(key).sort();

    expect(
      actual.filter((k) => !declared.includes(k)),
      'A legacy send-email route is not in the register. Migrate it, or declare it with a '
      + 'reason. NOTE: routes reached through a lib/email.ts wrapper count — that is exactly '
      + 'the class the first version of this guard missed.',
    ).toEqual([]);
    expect(
      declared.filter((k) => !actual.includes(k)),
      'A declared route no longer exists — delete its row so the register never overstates '
      + 'what is left.',
    ).toEqual([]);
  });

  it('every entry carries a real reason', () => {
    for (const e of REGISTER) {
      expect(e.reason.length, `${key(e)} needs a reason`).toBeGreaterThan(30);
    }
  });

  it('names every route that still blocks removing the PR 8 v1 bridge', () => {
    // The bridge exists ONLY because live send-email paths still consult v1 preference
    // columns. This asserts the blocking set is explicit, so "can we drop the bridge yet?"
    // is answered by the register instead of by memory.
    const blocking = REGISTER.filter((e) => e.status === 'pending').map((e) => e.file).sort();
    // NOTHING blocks it any more. Four booking routes moved to enqueue_booking_notification,
    // and 10c-b D moved the last one — notify-followers — to
    // enqueue_notification('open_slots_player'). This is the assertion that AUTHORIZES removing
    // the open_slots_digest key from the NotificationSettings.tsx bridge: the register, not
    // memory, is what answers "is any live send-email path still reading a v1 column?".
    expect(blocking).toEqual([]);
  });

  it('removed wrappers stay removed', () => {
    const lib = read('src/lib/email.ts');
    for (const fn of REMOVED_WRAPPERS) {
      expect(lib.includes(`export const ${fn}`), `${fn} was deleted as dead code`).toBe(false);
    }
  });

  it('files migrated off the legacy path never call it again', () => {
    const wrappers = Object.keys(namedWrappers());
    for (const { file, to } of MIGRATED_AWAY) {
      const src = read(file);
      const reaches = /invoke\(\s*["']send-email["']|\/functions\/v1\/send-email|sendEmail\(/.test(src)
        || wrappers.some((fn) => new RegExp(`\\b${fn}\\s*\\(`).test(src));
      expect(reaches, `${file} was migrated to ${to} — it must not reach send-email again`).toBe(false);
    }
  });
});

/**
 * THE RETIREMENT TRIPWIRE for the 10c-b J preference bridge.
 *
 * The register above answers a CALLER-side question — "does any live path in this repo still
 * re-enter send-email on a v1-gated type?" — and its answer is no, which is what authorised
 * removing the open_slots_digest control from NotificationSettings.tsx.
 *
 * That is not the same question as "may the compatibility bridge be deleted?", and conflating the
 * two is what the bridge exists to survive. The register measures the REPOSITORY; the thing that
 * still enforces v1 is the DEPLOYED send-email bundle, and in this repo edge functions are pushed
 * by hand after the frontend has already auto-deployed. While send-email's own TYPE_TO_PREF_COLUMN
 * still names open_slots_digest, some deployed bundle can still gate open-slot mail on the legacy
 * column, so both mirror directions must stay.
 *
 * These assertions are GREEN today and go RED the moment that stops being true — which is the
 * signal, and the only mechanical one, that 20261013100000 may be deleted.
 */
describe('10c-b J — when the preference bridge may be retired', () => {
  const BRIDGE_MIGRATION = 'supabase/migrations/20261013100000_notif_10cb_pref_bridge_v2_to_v1.sql';

  it('send-email still reads the v1 open_slots_digest column, so the bridge must stay', () => {
    const src = read('supabase/functions/send-email/index.ts');
    const map = /TYPE_TO_PREF_COLUMN[^=]*=\s*\{([\s\S]*?)\}/.exec(src);
    expect(map, 'send-email must still declare TYPE_TO_PREF_COLUMN').not.toBeNull();
    const stillReads = ['new_availability', 'slot_reopened']
      .filter((t) => new RegExp(`${t}\\s*:\\s*"open_slots_digest"`).test(map![1]));

    // When this goes red, read the RETIREMENT section at the foot of the bridge migration and
    // delete both mirrors, the guard, and this block — together, in 10c-d.
    expect(
      stillReads,
      'send-email no longer gates open slots on the v1 column: the J bridge is now removable',
    ).toEqual(['new_availability', 'slot_reopened']);
  });

  it('the bridge migration is present while a legacy reader remains', () => {
    expect(existsSync(join(ROOT, BRIDGE_MIGRATION)), `${BRIDGE_MIGRATION} is load-bearing`).toBe(true);
    const sql = read(BRIDGE_MIGRATION);
    // Both directions, or the gap reopens in whichever direction was dropped.
    expect(sql).toContain('CREATE TRIGGER trg_mirror_open_slots_pref_to_v1');
    expect(sql).toContain('notif_mirror_open_slots_pref_to_v2');
    expect(sql).toContain('notif_pref_bridge_hop_active');
  });
});
