import { describe, it, expect } from 'vitest';
import {
  buildRebookPaidResolver, claimInvoiceKeys, deriveGroupStatus, slotPhase,
  rebookPlayerOutcome, clickedYesUnpaid, summariseRebookOutcomes,
  sumRebookInvoiceAmounts,
  type RebookManagePlayer,
} from './rebookManage';

const future = new Date(Date.now() + 5 * 86400000).toISOString();
const past = new Date(Date.now() - 5 * 86400000).toISOString();

describe('slotPhase', () => {
  it('priority while the priority window is open', () => {
    expect(slotPhase({ priority_window_ends_at: future, member_window_ends_at: future, public_release_status: null })).toBe('priority');
  });
  it('members after priority, while the member window is open', () => {
    expect(slotPhase({ priority_window_ends_at: past, member_window_ends_at: future, public_release_status: null })).toBe('members');
  });
  it('public once released', () => {
    expect(slotPhase({ priority_window_ends_at: past, member_window_ends_at: past, public_release_status: 'released' })).toBe('public');
  });
  it('public after both windows lapse with auto release', () => {
    expect(slotPhase({ priority_window_ends_at: past, member_window_ends_at: past, public_release_status: 'auto_release_scheduled' })).toBe('public');
  });
  it('held when explicitly held / pending review', () => {
    expect(slotPhase({ priority_window_ends_at: past, member_window_ends_at: past, public_release_status: 'held' })).toBe('held');
    expect(slotPhase({ priority_window_ends_at: past, member_window_ends_at: past, public_release_status: 'pending_admin_review' })).toBe('held');
  });
});

describe('deriveGroupStatus', () => {
  it('rebooked wins regardless of phase (a kept spot is the headline)', () => {
    expect(deriveGroupStatus('rebooked', 'priority')).toBe('rebooked');
    expect(deriveGroupStatus('rebooked', 'public')).toBe('rebooked');
  });
  it('open-to-public when nobody claimed and it is released', () => {
    expect(deriveGroupStatus('declined', 'public')).toBe('public');
    expect(deriveGroupStatus('awaiting', 'public')).toBe('public');
  });
  it('open-to-members when nobody claimed and the member window is live', () => {
    expect(deriveGroupStatus('declined', 'members')).toBe('members');
    expect(deriveGroupStatus('awaiting', 'members')).toBe('members');
  });
  it("won't-rebook only when fully declined and not yet offered out", () => {
    expect(deriveGroupStatus('declined', 'priority')).toBe('declined');
    expect(deriveGroupStatus('declined', 'held')).toBe('declined');
  });
  it('awaiting while still pending in the priority window', () => {
    expect(deriveGroupStatus('awaiting', 'priority')).toBe('awaiting');
    expect(deriveGroupStatus('awaiting', 'held')).toBe('awaiting');
  });
});

describe('buildRebookPaidResolver (P1-1: rebook invoices are tagged rebook_cyclus_id / rebook_group_id, never cycle_id)', () => {
  it('single-claim invoice → paid/invoiced per player identity', () => {
    const r = buildRebookPaidResolver(
      [
        { player_id: 'p1', guest_player_id: null, status: 'paid' },
        { player_id: null, guest_player_id: 'g1', status: 'sent' },
        { player_id: 'p2', guest_player_id: null, status: 'cancelled' },
      ],
      [],
    );
    expect(r.isPaid('p1', null)).toBe(true);
    expect(r.hasInvoice('p1', null)).toBe(true);
    expect(r.isPaid('g:g1', null)).toBe(false); // invoiced but not paid
    expect(r.hasInvoice('g:g1', null)).toBe(true);
    expect(r.hasInvoice('p2', null)).toBe(false); // cancelled ignored
    expect(r.isPaid('pX', null)).toBe(false); // no invoice
  });

  it('group invoice → one payment covers EVERY member of that group', () => {
    const r = buildRebookPaidResolver([], [{ rebook_group_id: 'grpA', status: 'paid' }]);
    // The captain and every teammate in grpA are paid, keyed by their own identity + the group id.
    expect(r.isPaid('captain', 'grpA')).toBe(true);
    expect(r.isPaid('teammate2', 'grpA')).toBe(true);
    expect(r.hasInvoice('teammate3', 'grpA')).toBe(true);
    // A member of a DIFFERENT group is not covered.
    expect(r.isPaid('someone', 'grpB')).toBe(false);
    // Same identity outside any group is not covered by the group invoice.
    expect(r.isPaid('captain', null)).toBe(false);
  });

  it('group invoice that is only sent (unpaid) → invoiced but not paid for all members', () => {
    const r = buildRebookPaidResolver([], [{ rebook_group_id: 'grpA', status: 'sent' }]);
    expect(r.hasInvoice('m', 'grpA')).toBe(true);
    expect(r.isPaid('m', 'grpA')).toBe(false);
  });

  it('cancelled group invoice is ignored', () => {
    const r = buildRebookPaidResolver([], [{ rebook_group_id: 'grpA', status: 'cancelled' }]);
    expect(r.hasInvoice('m', 'grpA')).toBe(false);
    expect(r.isPaid('m', 'grpA')).toBe(false);
  });

  it('regression: reading by cycle_id yields nothing — an empty resolver marks everyone unpaid', () => {
    // If the query keys are wrong (the old bug), both lists are empty and no one is paid.
    const r = buildRebookPaidResolver([], []);
    expect(r.isPaid('p1', 'grpA')).toBe(false);
    expect(r.hasInvoice('p1', null)).toBe(false);
  });

  it('getPayToken: UNPAID invoices expose their /pay token — own single first, else the group one', () => {
    const r = buildRebookPaidResolver(
      [
        { player_id: 'p1', guest_player_id: null, status: 'sent', public_token: 'tok-single' },
        { player_id: 'p2', guest_player_id: null, status: 'paid', public_token: 'tok-paid' }, // paid → no link
        { player_id: 'p3', guest_player_id: null, status: 'cancelled', public_token: 'tok-dead' }, // cancelled → no link
      ],
      [{ rebook_group_id: 'g1', status: 'open', public_token: 'tok-group' }],
    );
    expect(r.getPayToken('p1', 'g1')).toBe('tok-single'); // own unpaid invoice wins
    expect(r.getPayToken('p2', null)).toBeNull(); // already paid
    expect(r.getPayToken('p3', null)).toBeNull(); // cancelled (zombie-swept)
    expect(r.getPayToken('p9', 'g1')).toBe('tok-group'); // teammate → the group's shared unpaid invoice
    expect(r.getPayToken('p9', 'g2')).toBeNull(); // no invoice anywhere
  });

  it('#6 regression (FAM-02): signup linker stamps player_id onto a PAID guest invoice — the guest claim stays paid, the profile does NOT inherit it', () => {
    // At mint the invoice was {null, g1}; after the guest signs up, link_guest_data_to_profile
    // re-keys it to {p1, g1} but the claim keeps guest_player_id (documented invariant).
    const r = buildRebookPaidResolver(
      [{ player_id: 'p1', guest_player_id: 'g1', status: 'paid' }],
      [],
    );
    // The guest claim resolves via its own guest key → still paid after signup.
    expect(r.isPaid(claimInvoiceKeys({ player_id: null, guest_player_id: 'g1' }), null)).toBe(true);
    expect(r.hasInvoice(claimInvoiceKeys({ player_id: null, guest_player_id: 'g1' }), null)).toBe(true);
    // The profile-holder's OWN claim must NOT read paid off the guest's invoice (false-PAID guard).
    expect(r.isPaid(claimInvoiceKeys({ player_id: 'p1', guest_player_id: null }), null)).toBe(false);
    expect(r.hasInvoice(claimInvoiceKeys({ player_id: 'p1', guest_player_id: null }), null)).toBe(false);
  });

  it('pre-#458 dual claim falls back to its player key when the invoice was minted player-only', () => {
    const r = buildRebookPaidResolver(
      [{ player_id: 'p1', guest_player_id: null, status: 'paid' }],
      [],
    );
    expect(r.isPaid(claimInvoiceKeys({ player_id: 'p1', guest_player_id: 'g1' }), null)).toBe(true);
  });

  it('getPayToken with ordered keys: the guest-keyed unpaid invoice wins over the player-keyed one, group token stays the last fallback', () => {
    const r = buildRebookPaidResolver(
      [
        { player_id: 'p1', guest_player_id: 'g1', status: 'sent', public_token: 'tok-guest' },
        { player_id: 'p1', guest_player_id: null, status: 'sent', public_token: 'tok-player' },
      ],
      [{ rebook_group_id: 'grpA', status: 'open', public_token: 'tok-group' }],
    );
    const dualKeys = claimInvoiceKeys({ player_id: 'p1', guest_player_id: 'g1' });
    expect(r.getPayToken(dualKeys, null)).toBe('tok-guest'); // ordered: guest identity first
    expect(r.getPayToken(claimInvoiceKeys({ player_id: 'p2', guest_player_id: null }), 'grpA')).toBe('tok-group');
  });
});

describe('claimInvoiceKeys — ordered invoice-match keys per claim identity (FAM-02 Level 1)', () => {
  it('guest claim → guest key only', () => {
    expect(claimInvoiceKeys({ player_id: null, guest_player_id: 'g1' })).toEqual(['g:g1']);
  });
  it('player claim → player key only', () => {
    expect(claimInvoiceKeys({ player_id: 'p1', guest_player_id: null })).toEqual(['p1']);
  });
  it('pre-#458 dual claim → guest key first, player key as fallback', () => {
    expect(claimInvoiceKeys({ player_id: 'p1', guest_player_id: 'g1' })).toEqual(['g:g1', 'p1']);
  });
});

const mkPlayer = (over: Partial<RebookManagePlayer>): RebookManagePlayer => ({
  key: 'k', playerId: 'p', guestPlayerId: null, name: 'X',
  response: 'pending', responseIntent: null, paid: false, hasInvoice: false, invited: false,
  claimIds: [], lastRemindedAt: null,
  hasEmail: true, claimToken: null, payToken: null,
  ...over,
});

describe('sumRebookInvoiceAmounts — € paid vs outstanding', () => {
  it('sums paid vs outstanding across single + group invoices, excluding cancelled', () => {
    const single = [
      { player_id: 'a', guest_player_id: null, status: 'paid', total: 30 },
      { player_id: 'b', guest_player_id: null, status: 'sent', total: 20 },
      { player_id: 'c', guest_player_id: null, status: 'cancelled', total: 99 }, // excluded
    ];
    const group = [
      { rebook_group_id: 'g1', status: 'paid', total: 100 },
      { rebook_group_id: 'g2', status: 'overdue', total: 40 },
    ];
    expect(sumRebookInvoiceAmounts(single, group)).toEqual({ paidAmount: 130, outstandingAmount: 60 });
  });

  it('treats missing/null totals as 0 and returns zeros for no invoices', () => {
    expect(sumRebookInvoiceAmounts([{ player_id: 'a', guest_player_id: null, status: 'paid', total: null }], [])).toEqual({ paidAmount: 0, outstandingAmount: 0 });
    expect(sumRebookInvoiceAmounts([], [])).toEqual({ paidAmount: 0, outstandingAmount: 0 });
  });
});

describe('rebookPlayerOutcome — the owner\'s "who said no"', () => {
  it('claimed ⇒ rebooked', () => {
    expect(rebookPlayerOutcome(mkPlayer({ response: 'claimed' }))).toBe('rebooked');
  });
  it('explicit declined status ⇒ declined', () => {
    expect(rebookPlayerOutcome(mkPlayer({ response: 'declined' }))).toBe('declined');
  });
  it('clicked "No" on the email but claim still pending ⇒ declined (not silence)', () => {
    expect(rebookPlayerOutcome(mkPlayer({ response: 'pending', responseIntent: 'decline' }))).toBe('declined');
  });
  it('never responded (pending, no intent) ⇒ noResponse', () => {
    expect(rebookPlayerOutcome(mkPlayer({ response: 'pending' }))).toBe('noResponse');
  });
  it('expired without a decline ⇒ noResponse, NOT a decline', () => {
    expect(rebookPlayerOutcome(mkPlayer({ response: 'expired' }))).toBe('noResponse');
  });
  it('clicked "Yes" but never paid ⇒ noResponse for the headline, flagged via clickedYesUnpaid', () => {
    const p = mkPlayer({ response: 'pending', responseIntent: 'accept' });
    expect(rebookPlayerOutcome(p)).toBe('noResponse');
    expect(clickedYesUnpaid(p)).toBe(true);
  });
  it('a paid, claimed player is not "clicked-yes-unpaid"', () => {
    expect(clickedYesUnpaid(mkPlayer({ response: 'claimed', responseIntent: 'accept', paid: true }))).toBe(false);
  });
  it('an EXPIRED accept-intent claim is NOT clicked-yes-unpaid (can no longer be completed)', () => {
    // Cron expires the pending claim but leaves response_intent='accept'. It must not be counted as
    // an actionable "started but didn't pay", and must not collide with the "verlopen" chip.
    expect(clickedYesUnpaid(mkPlayer({ response: 'expired', responseIntent: 'accept' }))).toBe(false);
  });
});

describe('summariseRebookOutcomes — the assembled headline', () => {
  it('counts invited / rebooked / declined / no-response distinctly', () => {
    const s = summariseRebookOutcomes([
      mkPlayer({ key: 'a', response: 'claimed' }),
      mkPlayer({ key: 'b', response: 'claimed' }),
      mkPlayer({ key: 'c', response: 'declined' }),
      mkPlayer({ key: 'd', response: 'pending', responseIntent: 'decline' }), // clicked No
      mkPlayer({ key: 'e', response: 'pending' }),                             // silent
      mkPlayer({ key: 'f', response: 'expired' }),                            // silent
      mkPlayer({ key: 'g', response: 'pending', responseIntent: 'accept' }),  // clicked yes, unpaid
    ]);
    expect(s).toEqual({ invited: 7, rebooked: 2, declined: 2, noResponse: 3, clickedYesUnpaid: 1 });
  });

  it('counts DISTINCT invitees — a player in two weekly series is one person, not two', () => {
    // Same identity ('key: a') appears in two groups (Mon + Wed of one round).
    const s = summariseRebookOutcomes([
      mkPlayer({ key: 'a', response: 'claimed' }),   // Monday series: rebooked
      mkPlayer({ key: 'a', response: 'pending' }),    // Wednesday series: still silent
      mkPlayer({ key: 'b', response: 'declined' }),
    ]);
    // 'a' collapses to the strongest outcome (rebooked); not double-counted.
    expect(s).toEqual({ invited: 2, rebooked: 1, declined: 1, noResponse: 0, clickedYesUnpaid: 0 });
  });

  it('collapses strongest outcome: rebooked one series beats a decline in another', () => {
    const s = summariseRebookOutcomes([
      mkPlayer({ key: 'a', response: 'claimed' }),
      mkPlayer({ key: 'a', response: 'declined' }),
    ]);
    expect(s).toEqual({ invited: 1, rebooked: 1, declined: 0, noResponse: 0, clickedYesUnpaid: 0 });
  });

  it('clicked-yes-unpaid is dropped once the invitee rebooked any of their series', () => {
    const s = summariseRebookOutcomes([
      mkPlayer({ key: 'a', response: 'pending', responseIntent: 'accept' }), // clicked yes, unpaid here
      mkPlayer({ key: 'a', response: 'claimed' }),                            // but completed elsewhere
    ]);
    expect(s).toEqual({ invited: 1, rebooked: 1, declined: 0, noResponse: 0, clickedYesUnpaid: 0 });
  });
});
