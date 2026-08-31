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

  it('send-priority-claim-invitation keys the SERIES pair-exactly, and identity guest-first', () => {
    // `OWNER_DECISION_D7_RUNTIME_PRIORITY_INVITE_SEMANTICS_V1` split this into two questions.
    //
    // WHICH SERIES a claim belongs to is pair-exact, because `respond_to_priority_claim` books the
    // exact `(player_id, guest_player_id)` pair. Guest-first grouping collapsed `(P, G)` with
    // `(NULL, G)`, so only one of the two was ever invited and later drains reported nothing
    // remaining while the other stayed pending (review round 2).
    //
    // WHO a person is stays guest-first: dedup of a dual-key child against their linked parent,
    // display names, and contact resolution are all unchanged, and FAM-02 is still pinned below.
    const s = fn('send-priority-claim-invitation');
    expect(s).toContain('from "../_shared/person-identity.ts"');
    // The SERIES keys — representative discovery and the main-loop lookup — carry both columns.
    expect(s).toMatch(/const k = `\$\{gkey\}\|p:\$\{c\.player_id \?\? ""\}\|g:\$\{c\.guest_player_id \?\? ""\}`/);
    expect(s).toContain('groupInfo.get(groupSeriesKey(c))');
    // ...and the aggregation it looks into is built with the SAME key, or the lookup misses and the
    // mail silently describes a plain session.
    const ctx = readFileSync(
      join(process.cwd(), 'supabase', 'functions', '_shared', 'rebook-invitation-context.ts'), 'utf8');
    expect(ctx).toContain('const key = groupSeriesKey(gc);');
    expect(ctx).toMatch(/export function groupSeriesKey[\s\S]{0,400}?p:\$\{row\.player_id \?\? ""\}\|g:\$\{row\.guest_player_id \?\? ""\}/);
    // IDENTITY is still guest-first.
    expect(s).toContain('const playerKey = personKeyOf(c);');  // dedup/display identity
    expect(s).toContain('guestContactName(c.guest_player_id, guestMap)'); // verified name (never player_id)
    expect(s).not.toMatch(/c\.player_id \?\? `g:\$\{c\.guest_player_id\}`/); // old key gone
  });
});

describe('PR 10d wiring — upstream producers preserve both people (proofs #1, #2)', () => {
  it('bulk-rebook-cycle representative selection is guest-first (proof #2)', () => {
    const s = fn('bulk-rebook-cycle');
    // The guest-first identity helper is no longer imported here at all: this producer's ONLY use
    // of a person key was its representative rule, and that is now the pair-exact series key. An
    // import that is gone cannot drift back into a second leader rule (D2).
    expect(s, 'no guest-first key survives in this producer')
      .not.toContain('personKeyOf');
    // PAIR-EXACT, PER SERIES (`APPROVE_D7_RUNTIME_FINAL_CONVERGENCE_V1`, D2). This producer keyed
    // its representative GUEST-FIRST and CYCLE-WIDE — collapsing `(P, G)` with `(NULL, G)`, and
    // picking one claim per PERSON rather than one per series. It was the third leader rule in the
    // system, and two rules disagreeing is what produced duplicate invitations. It now uses the key
    // the offer, the sender and the accept all use.
    expect(s).toMatch(/const k = `\$\{rebookGroupId \?\? cl\.slot_id\}\|p:\$\{cl\.player_id \?\? ""\}\|g:\$\{cl\.guest_player_id \?\? ""\}`/);
    expect(s, 'and it breaks ties the way the offer does')
      .toContain('(start === cur.start && cl.id < cur.claimId)');
    expect(s, 'the guest-first representative key is gone')
      .not.toContain('const pkey = personKeyOf(cl);');
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
    // ...and the INVITATION count is keyed PAIR-EXACTLY, because the sender enqueues and stamps one
    // representative per exact (player, guest) pair. Counted guest-first, a row covering two pairs
    // reported "1/1" and drove `uninvitedCount` to zero as soon as either was stamped — hiding the
    // Resume control while an invitation was still unqueued (review round 3).
    expect(s).toMatch(/const invitePairOf = [\s\S]{0,160}?p:\$\{c\.player_id \?\? ''\}\|g:\$\{c\.guest_player_id \?\? ''\}/);
    expect(s).toContain('if (c.status === \'pending\') pendingPairs.add(pairKey);');
    // The three figures are computed over ONE set so they cannot disagree: `total` is every
    // invitation the round has or still needs, `sent` counts the stamped ones INCLUDING answered
    // claims (the invitation was still queued), and `uninvited` is what Resume has left.
    expect(s).toContain('const allPairs = new Set([...pendingPairs, ...invitedKeys]);');
    expect(s).toContain('for (const k of allPairs) if (invitedKeys.has(k)) invitesSent += 1;');
    expect(s).toContain('for (const k of pendingPairs) if (!invitedKeys.has(k)) uninvitedCount += 1;');
    expect(s).toContain('const invitesTotal = allPairs.size;');
    expect(s).toContain('nameByKey.set(`p:${p.id}`');                       // profile names renamespaced to match
    expect(s).not.toContain('c.player_id ?? `g:${c.guest_player_id}`;');    // the old player-first keyOf body
  });

  // THE THREE `notify-rebook-member-open` PINS ARE GONE WITH THE FUNCTION. D7's runtime cutover
  // hard-retired the notifier and `_shared/rebook-member-open.ts`, so the guest-first recipient
  // keying, the fail-loud reads and the `runClaimedCycle` recovery they pinned no longer have a
  // call site to be wired to. Their SUBSTANCE moved into the database: the recipient universe is
  // frozen per round, contact is re-resolved at dispatch, and recovery is
  // `rebook_member_open_recover_expired_leases`. Deleting the pins rather than repointing them is
  // deliberate — a pin that reads a deleted file cannot fail for the right reason.
  // `src/test/d7RuntimeWiring.test.ts` holds the absence control.
  it('the other three senders fail loud on their load-bearing reads', () => {
    expect(fn('send-rebook-reminder')).toContain('claims read failed');
    expect(fn('send-rebook-reminder')).toContain('slot read failed');
    expect(fn('send-rebook-group-confirmation')).toContain('member read failed');
    expect(fn('send-rebook-group-confirmation')).toContain('invited-state read failed');
    expect(fn('auto-rebook-reminder')).toContain('slot read failed — skipping cycle');
  });
});
