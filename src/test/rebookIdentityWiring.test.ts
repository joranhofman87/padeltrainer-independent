// @vitest-environment node
// PR 10d wiring pins for the rebook senders + producers. These edge functions are Deno HTTP
// handlers (Resend + DB) that cannot be unit-run in vitest, and buildRebookManageView issues ~8
// chained supabase queries; the IDENTITY DECISIONS inside them are the tested person-identity
// helpers (personKeyOf/personRefOf/personContactEmail/personDisplayName, proven in
// personIdentity*.test.ts) and the SQL chain (proven end-to-end in rebookIdentityGuestFirst.pglite).
// What a helper/pglite test cannot see is whether each call site is WIRED to the guest-first
// helper and the old player-first pattern is gone — that is what these pins hold. Each pin asserts
// PRESENCE of the guest-first wiring AND ABSENCE of the specific player-first bug signature, so a
// revert to player-first fails here even though the helpers stay green.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');
const fn = (name: string) => read('supabase', 'functions', name, 'index.ts');
const shared = (name: string) => read('supabase', 'functions', '_shared', name);

describe('PR 10d wiring — manual flows deliver independently to parent + dual-key child (proof #3)', () => {
  // Codex round-3 #1: all THREE manual senders resolve a guest's email via the VERIFIED account
  // resolver (own → account, person_links/twin/linked), NEVER the raw claim.player_id.
  it('all three manual senders use the verified guest-contact resolver, never raw player_id', () => {
    for (const name of ['send-rebook-reminder', 'send-priority-claim-invitation', 'send-rebook-group-confirmation']) {
      const s = fn(name);
      expect(s, `${name} imports the verified resolver`).toContain('from "../_shared/rebook-guest-contact.ts"');
      expect(s, `${name} resolves guest email via guestContactEmail`).toContain('guestContactEmail(');
      expect(s, `${name} batch-fetches via fetchGuestContacts`).toContain('fetchGuestContacts(');
      // the old profile-first fallbacks that could route to the raw player_id are gone
      expect(s, `${name} no longer uses resolveRecipient`).not.toContain('resolveRecipient(');
      expect(s, `${name} no longer uses personContactEmail`).not.toContain('personContactEmail(');
      expect(s, `${name} no longer uses effectiveGuestEmail`).not.toContain('effectiveGuestEmail(');
    }
  });

  it('send-rebook-reminder keys + stamps guest-first', () => {
    const s = fn('send-rebook-reminder');
    expect(s).toContain('targetList.map((t) => personKeyOf(t))');      // target keys
    expect(s).toContain('const key = personKeyOf(c);');                // dedup
    expect(s).toMatch(/const ref = personRefOf\(c\);[\s\S]*sentGuestIds\.push\(ref\.guestPlayerId\)/); // stamp routing
    expect(s).not.toMatch(/if \(c\.player_id\) sentPlayerIds\.push\(c\.player_id\)/);                   // old routing gone
  });

  it('send-rebook-group-confirmation groups guest-first, scopes the stamp with a guest-null guard, and SENDS-THEN-STAMPS with idempotency (#3)', () => {
    const s = fn('send-rebook-group-confirmation');
    expect(s).toContain('const key = personKeyOf(c);');                        // member grouping
    expect(s).toMatch(/personKeyOf\(r\)/);                                     // invitedKeys
    // the seat/claim guard: a profile-scoped stamp must add guest_player_id IS NULL
    expect(s).toMatch(/stampQ\.eq\("player_id", ref!\.playerId\)\.is\("guest_player_id", null\)/);
    // #3: deterministic idempotency key + send-THEN-stamp (no fragile claim-before-send + clear)
    expect(s).toContain('idempotencyKey: `rebook-group-confirm:${groupId}:${m.key}`');
    expect(s).not.toContain('confirmation_sent_at: null'); // the clear-on-failure (permanent-suppression) path is gone
    // Codex round-5 #3: the send/stamp loop is the testable runGroupConfirmations driver, and `ok`
    // comes from groupConfirmOk (failed===0 && unresolved===0) — a stamp failure returns "unresolved".
    expect(s).toContain('runGroupConfirmations(members.values()');
    expect(s).toContain('ok: groupConfirmOk(tally)');
    expect(s).toMatch(/if \(!outcome\.ok\) return "send_failed";[\s\S]*return "unresolved";[\s\S]*return "sent";/); // send first, then stamp
  });

  it('send-priority-claim-invitation keys guest-first', () => {
    const s = fn('send-priority-claim-invitation');
    expect(s).toContain('from "../_shared/person-identity.ts"');
    expect(s).toContain('const pkey = personKeyOf(c);');       // representative dedup
    // group aggregation moved into _shared/rebook-invitation-context.ts (loadInvitationMetadata) and
    // is now RUNTIME-tested there (a 1500-session series aggregates under `grp1|p:p1`, not the parent).
    expect(s).toContain('const playerKey = personKeyOf(c);');  // main-loop lookup
    expect(s).toContain('guestContactName(c.guest_player_id, guestMap)'); // verified name (never player_id)
    expect(s).not.toMatch(/c\.player_id \?\? `g:\$\{c\.guest_player_id\}`/); // old key gone
  });
});

describe('PR 10d wiring — upstream producers preserve both people (proofs #1, #2)', () => {
  it('bulk-rebook-cycle representative selection is guest-first (proof #2)', () => {
    const s = fn('bulk-rebook-cycle');
    expect(s).toContain('import { personKeyOf } from "../_shared/person-identity.ts";');
    expect(s).toContain('const pkey = personKeyOf(cl);');
    expect(s).not.toMatch(/const pkey = cl\.player_id \?\? `g:\$\{cl\.guest_player_id\}`/); // old collapse gone
  });

  it('auto-rebook-reminder cron sender routes the stamp guest-first', () => {
    const s = fn('auto-rebook-reminder');
    expect(s).toContain('import { personRefOf } from "../_shared/person-identity.ts";');
    expect(s).toMatch(/personRefOf\(\{ player_id: rec\.player_id, guest_player_id: rec\.guest_player_id \}\)/);
    expect(s).not.toMatch(/if \(rec\.player_id\) sentPlayerIds\.push\(rec\.player_id\)/); // old routing gone
  });

  it('frontend rebookManage builds targets guest-first (proof #1): keyOf = personKeyOf, nameByKey namespaced', () => {
    const s = read('src', 'lib', 'rebookManage.ts');
    expect(s).toContain("import { personKeyOf } from '@/lib/personIdentity';");
    expect(s).toContain('personKeyOf(c) ?? ');                              // keyOf → guest-first key
    expect(s).toContain('nameByKey.set(`p:${p.id}`');                       // profile names renamespaced to match
    expect(s).not.toContain('c.player_id ?? `g:${c.guest_player_id}`;');    // the old player-first keyOf body
  });

  it('notify-rebook-member-open keys recipients/stamp guest-first (helper) and resolves contact guest-first', () => {
    const h = shared('rebook-member-open.ts');
    // recipientKey is guest-first but format-preserving (pure profile bare id, guest g:<id>)
    expect(h).toContain('r.guest_player_id ? `g:${r.guest_player_id}` : (r.player_id ?? null);');
    expect(h).not.toContain('r.player_id ?? (r.guest_player_id ? `g:${r.guest_player_id}` : null);'); // old player-first
    expect(h).toContain('export function resolveMemberOpenContact(');       // guest-first name/email + parent fallback
    const s = fn('notify-rebook-member-open');
    expect(s).toContain('resolveMemberOpenContact(a, maps)');
    expect(s).toContain('needsSignup: contact.needsSignup');               // linked accounts don't get a signup CTA
    expect(s).not.toContain('key.startsWith("g:")'); // isGuest now derived from the id, not the (moved) key format
  });

  it('notify-rebook-member-open fails loud on recipient-discovery reads + releases the claim on failure', () => {
    const s = fn('notify-rebook-member-open');
    // load-bearing reads throw instead of masquerading as empty (→ no permanent claim / silent drop)
    for (const m of ['cycle read failed', 'slots read failed', 'claims read failed', 'profiles read failed',
                     'guest contact resolution failed', 'round lookup failed']) {
      expect(s, `must fail loud on: ${m}`).toContain(m);
    }
    // recovery is the shared, tested runClaimedCycle (release on partial/throw + surface unclaim errors)
    expect(s).toContain('runClaimedCycle(supabase, cycleId, (id) => notifyCycle(supabase, resendApiKey, id))');
    const h = shared('rebook-member-open.ts');
    expect(h).toContain('export async function runClaimedCycle(');
    expect(h).toContain('export async function releaseMemberOpenClaim('); // catches a thrown unclaim too
  });

  it('member-open account resolution mirrors booking authorization + is crash-safe (findings #1/#3)', () => {
    const s = fn('notify-rebook-member-open');
    // #3: a guest's account/email come from the guest's OWN verified relationships (SQL RPC), not player_id
    expect(s).toContain('resolve_guest_member_contacts');
    // #1: deterministic idempotency key + ATOMIC per-recipient checkpoint (no whole-settings rewrite)
    expect(s).toContain('idempotencyKey: `member-open:${cycleId}:${r.key}`');
    expect(s).toContain('append_rebook_member_open_notified');
    expect(s).not.toContain('rebook_member_open_notified_recipients: merged'); // the old read-modify-write is gone
    // the migration provides the guest account resolver matching can_book_member_window
    const mig = read('supabase', 'migrations', '20260927100000_rebook_identity_guest_first.sql');
    expect(mig).toContain('guest_verified_account_profile');
    expect(mig).toContain('is_guest_split_frozen'); // split-freeze respected
  });

  it('the other three senders fail loud on their load-bearing reads', () => {
    expect(fn('send-rebook-reminder')).toContain('claims read failed');
    expect(fn('send-rebook-reminder')).toContain('slot read failed');
    expect(fn('send-rebook-group-confirmation')).toContain('member read failed');
    expect(fn('send-rebook-group-confirmation')).toContain('invited-state read failed');
    expect(fn('auto-rebook-reminder')).toContain('slot read failed — skipping cycle');
  });
});
