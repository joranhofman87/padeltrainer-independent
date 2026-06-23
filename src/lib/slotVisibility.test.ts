import { describe, it, expect } from 'vitest';
import { computeReleasedSlotIds } from './slotVisibility';

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
