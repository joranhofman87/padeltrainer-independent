import { describe, it, expect } from 'vitest';
import { computeReleasedSlotIds, isPriorityWindowActive } from './slotVisibility';
import { getSlotVisibility } from './priorityClaims';

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString();

describe('computeReleasedSlotIds (M9: shared-slot decline must not free the slot)', () => {
  it('does NOT release a shared slot when one co-occupant declined but others are still pending', () => {
    const released = computeReleasedSlotIds([
      { slot_id: 'A', status: 'declined' },
      { slot_id: 'A', status: 'pending' },
      { slot_id: 'A', status: 'pending' },
    ]);
    expect(released.has('A')).toBe(false);
  });

  it('does NOT release a slot where one co-occupant declined but another already claimed', () => {
    const released = computeReleasedSlotIds([
      { slot_id: 'A', status: 'declined' },
      { slot_id: 'A', status: 'claimed' },
    ]);
    expect(released.has('A')).toBe(false);
  });

  it('releases a slot only when every claim has freed (all declined/expired/released)', () => {
    const released = computeReleasedSlotIds([
      { slot_id: 'A', status: 'declined' },
      { slot_id: 'A', status: 'expired' },
      { slot_id: 'A', status: 'released' },
    ]);
    expect(released.has('A')).toBe(true);
  });

  it('keeps slots independent: A fully declined is released, B half-pending is not', () => {
    const released = computeReleasedSlotIds([
      { slot_id: 'A', status: 'declined' },
      { slot_id: 'B', status: 'declined' },
      { slot_id: 'B', status: 'pending' },
    ]);
    expect(released.has('A')).toBe(true);
    expect(released.has('B')).toBe(false);
  });

  it('does not release a slot with only pending/claimed claims', () => {
    const released = computeReleasedSlotIds([
      { slot_id: 'A', status: 'pending' },
      { slot_id: 'A', status: 'claimed' },
    ]);
    expect(released.has('A')).toBe(false);
  });

  it('returns an empty set for no claims', () => {
    expect(computeReleasedSlotIds([]).size).toBe(0);
  });
});

describe('isPriorityWindowActive', () => {
  it('is true only while the window end is in the future', () => {
    expect(isPriorityWindowActive(FUTURE)).toBe(true);
    expect(isPriorityWindowActive(PAST)).toBe(false);
    expect(isPriorityWindowActive(null)).toBe(false);
    expect(isPriorityWindowActive(undefined)).toBe(false);
  });
});

describe('public listing hides reserved rebook slots during the priority window', () => {
  // Reproduces the anon path: filterVisibleSlotIds can't read slot_priority_claims
  // (RLS TO authenticated), so it now passes hasPendingPriority conservatively from
  // the live window. This pins that an anon viewer never sees a held slot as public,
  // while a matching claim token still does.
  const anonArgs = {
    slotId: 'S1',
    priorityWindowEndsAt: FUTURE,
    // Conservative override the public path applies: window active ⇒ treat as held
    // even though the RLS-blind claims read returned nothing.
    hasPendingPriority: isPriorityWindowActive(FUTURE),
    hasReleasedSeat: false,
    memberWindowEndsAt: null,
    publicReleaseStatus: 'auto_release_scheduled' as const,
    isCycleMember: false,
  };

  it('anon (no claim token) sees a live-priority slot as non-public (hidden)', () => {
    expect(getSlotVisibility(anonArgs)).toBe('priority');
  });

  it('the matching claim-token holder still sees their own slot', () => {
    expect(getSlotVisibility({ ...anonArgs, claimToken: 'tok', claimSlotId: 'S1' })).toBe('public');
  });

  it('after the priority window ends, a default slot returns to public', () => {
    expect(getSlotVisibility({ ...anonArgs, priorityWindowEndsAt: PAST, hasPendingPriority: isPriorityWindowActive(PAST) })).toBe('public');
  });
});
