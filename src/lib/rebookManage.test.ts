import { describe, it, expect } from 'vitest';
import { buildRebookPaidResolver, deriveGroupStatus, slotPhase } from './rebookManage';

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
});
