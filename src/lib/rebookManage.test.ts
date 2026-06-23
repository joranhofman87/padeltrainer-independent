import { describe, it, expect } from 'vitest';
import { deriveGroupStatus, slotPhase } from './rebookManage';

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
