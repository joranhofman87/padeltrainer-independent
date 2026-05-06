import { describe, it, expect } from 'vitest';
import {
  computePriorityWindowEnd,
  applyWeeksOffset,
  shouldHidePrioritySlot,
  getSlotVisibility,
  type ClaimStatus,
} from './priorityClaims';

describe('computePriorityWindowEnd', () => {
  it('adds N days to the given now', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(computePriorityWindowEnd(now, 7).toISOString()).toBe('2026-01-08T00:00:00.000Z');
  });
  it('returns same instant when days = 0', () => {
    const now = new Date('2026-01-01T12:34:56.000Z');
    expect(computePriorityWindowEnd(now, 0).getTime()).toBe(now.getTime());
  });
});

describe('applyWeeksOffset', () => {
  it('shifts ISO timestamp by exact 7-day weeks', () => {
    expect(applyWeeksOffset('2026-01-01T10:00:00.000Z', 1))
      .toBe('2026-01-08T10:00:00.000Z');
    expect(applyWeeksOffset('2026-01-15T08:00:00.000Z', 2))
      .toBe('2026-01-29T08:00:00.000Z');
  });
  it('supports negative offsets', () => {
    expect(applyWeeksOffset('2026-01-15T00:00:00.000Z', -1))
      .toBe('2026-01-08T00:00:00.000Z');
  });
});

describe('shouldHidePrioritySlot', () => {
  const now = new Date('2026-05-01T00:00:00.000Z');
  const futureWindow = '2026-05-08T00:00:00.000Z';
  const pastWindow = '2026-04-01T00:00:00.000Z';

  it('hides slot inside active window with pending priority and no released seats', () => {
    expect(shouldHidePrioritySlot({
      slotId: 's1', windowEndsAt: futureWindow,
      hasPendingPriority: true, hasReleasedSeat: false, now,
    })).toBe(true);
  });

  it('shows slot when window already expired', () => {
    expect(shouldHidePrioritySlot({
      slotId: 's1', windowEndsAt: pastWindow,
      hasPendingPriority: true, hasReleasedSeat: false, now,
    })).toBe(false);
  });

  it('shows slot when no priority window is set', () => {
    expect(shouldHidePrioritySlot({
      slotId: 's1', windowEndsAt: null,
      hasPendingPriority: true, hasReleasedSeat: false, now,
    })).toBe(false);
  });

  it('shows slot when at least one seat has been released', () => {
    expect(shouldHidePrioritySlot({
      slotId: 's1', windowEndsAt: futureWindow,
      hasPendingPriority: true, hasReleasedSeat: true, now,
    })).toBe(false);
  });

  it('shows slot when no pending priority claims exist', () => {
    expect(shouldHidePrioritySlot({
      slotId: 's1', windowEndsAt: futureWindow,
      hasPendingPriority: false, hasReleasedSeat: false, now,
    })).toBe(false);
  });

  it('claim token bypass: matching token+slot reveals hidden slot', () => {
    expect(shouldHidePrioritySlot({
      slotId: 's1', windowEndsAt: futureWindow,
      hasPendingPriority: true, hasReleasedSeat: false,
      claimToken: 'tok', claimSlotId: 's1', now,
    })).toBe(false);
  });

  it('claim token for different slot does not bypass', () => {
    expect(shouldHidePrioritySlot({
      slotId: 's1', windowEndsAt: futureWindow,
      hasPendingPriority: true, hasReleasedSeat: false,
      claimToken: 'tok', claimSlotId: 's2', now,
    })).toBe(true);
  });

  it('uses current time when now is not provided', () => {
    // window in the past relative to actual now -> should not hide
    expect(shouldHidePrioritySlot({
      slotId: 's1', windowEndsAt: '2000-01-01T00:00:00.000Z',
      hasPendingPriority: true, hasReleasedSeat: false,
    })).toBe(false);
  });
});

describe('ClaimStatus union', () => {
  it('contains all expected statuses', () => {
    const all: ClaimStatus[] = ['pending', 'claimed', 'declined', 'expired', 'released'];
    expect(all).toHaveLength(5);
  });
});

describe('getSlotVisibility', () => {
  const now = new Date('2026-05-01T00:00:00.000Z');
  const future = '2026-05-08T00:00:00.000Z';
  const past = '2026-04-01T00:00:00.000Z';
  const base = {
    slotId: 's1',
    priorityWindowEndsAt: null,
    hasPendingPriority: false,
    hasReleasedSeat: false,
    memberWindowEndsAt: null,
    publicReleaseStatus: 'auto_release_scheduled' as const,
    isCycleMember: false,
    now,
  };

  it('returns priority during active priority window with pending and no release', () => {
    expect(getSlotVisibility({
      ...base, priorityWindowEndsAt: future, hasPendingPriority: true,
    })).toBe('priority');
  });

  it('claim token bypasses priority and shows as public', () => {
    expect(getSlotVisibility({
      ...base, priorityWindowEndsAt: future, hasPendingPriority: true,
      claimToken: 'tok', claimSlotId: 's1',
    })).toBe('public');
  });

  it('returns members during active member window for non-members', () => {
    expect(getSlotVisibility({
      ...base, memberWindowEndsAt: future, isCycleMember: false,
    })).toBe('members');
  });

  it('returns public during member window for cycle members', () => {
    expect(getSlotVisibility({
      ...base, memberWindowEndsAt: future, isCycleMember: true,
    })).toBe('public');
  });

  it('returns hidden when public_release_status is held', () => {
    expect(getSlotVisibility({
      ...base, publicReleaseStatus: 'held',
    })).toBe('hidden');
  });

  it('returns hidden when pending_admin_review', () => {
    expect(getSlotVisibility({
      ...base, publicReleaseStatus: 'pending_admin_review',
    })).toBe('hidden');
  });

  it('returns public when all windows have passed and status auto', () => {
    expect(getSlotVisibility({
      ...base, priorityWindowEndsAt: past, memberWindowEndsAt: past,
      publicReleaseStatus: 'auto_release_scheduled',
    })).toBe('public');
  });

  it('returns public when status is released', () => {
    expect(getSlotVisibility({
      ...base, publicReleaseStatus: 'released',
    })).toBe('public');
  });

  it('priority takes precedence over member window', () => {
    expect(getSlotVisibility({
      ...base,
      priorityWindowEndsAt: future, hasPendingPriority: true,
      memberWindowEndsAt: future, isCycleMember: true,
    })).toBe('priority');
  });

  it('skips priority when seat already released', () => {
    expect(getSlotVisibility({
      ...base,
      priorityWindowEndsAt: future, hasPendingPriority: true, hasReleasedSeat: true,
      memberWindowEndsAt: future, isCycleMember: false,
    })).toBe('members');
  });
});
