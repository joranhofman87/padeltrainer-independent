import { describe, it, expect } from 'vitest';
import {
  resolveSlotTier,
  canPlayerBookSlot,
} from '../../supabase/functions/_shared/slot-tier.ts';

const NOW = new Date('2026-06-10T12:00:00.000Z');
const FUTURE = '2026-06-20T12:00:00.000Z';
const PAST = '2026-06-01T12:00:00.000Z';

describe('resolveSlotTier', () => {
  it('is priority while the window is open and a claim is still pending', () => {
    expect(
      resolveSlotTier({
        priorityWindowEndsAt: FUTURE,
        hasPendingClaim: true,
        memberWindowEndsAt: null,
        publicReleaseStatus: 'auto_release_scheduled',
        now: NOW,
      }),
    ).toBe('priority');
  });

  it('leaves priority once no claims are pending (all resolved → opens early)', () => {
    expect(
      resolveSlotTier({
        priorityWindowEndsAt: FUTURE,
        hasPendingClaim: false,
        memberWindowEndsAt: null,
        publicReleaseStatus: 'auto_release_scheduled',
        now: NOW,
      }),
    ).toBe('public');
  });

  it('leaves priority once the window has passed even if a claim lingers', () => {
    expect(
      resolveSlotTier({
        priorityWindowEndsAt: PAST,
        hasPendingClaim: true,
        memberWindowEndsAt: null,
        publicReleaseStatus: 'auto_release_scheduled',
        now: NOW,
      }),
    ).toBe('public');
  });

  it('is members during the member window', () => {
    expect(
      resolveSlotTier({
        priorityWindowEndsAt: PAST,
        hasPendingClaim: false,
        memberWindowEndsAt: FUTURE,
        publicReleaseStatus: 'auto_release_scheduled',
        now: NOW,
      }),
    ).toBe('members');
  });

  it('is hidden when held or pending admin review', () => {
    expect(
      resolveSlotTier({
        priorityWindowEndsAt: null,
        hasPendingClaim: false,
        memberWindowEndsAt: null,
        publicReleaseStatus: 'held',
        now: NOW,
      }),
    ).toBe('hidden');
    expect(
      resolveSlotTier({
        priorityWindowEndsAt: null,
        hasPendingClaim: false,
        memberWindowEndsAt: null,
        publicReleaseStatus: 'pending_admin_review',
        now: NOW,
      }),
    ).toBe('hidden');
  });
});

describe('canPlayerBookSlot', () => {
  const seat = { seatsTaken: 0, maxParticipants: 4 };

  it('blocks a full slot regardless of tier (capacity / overbooking guard)', () => {
    expect(
      canPlayerBookSlot({ tier: 'public', playerHoldsClaim: false, isCycleMember: false, seatsTaken: 4, maxParticipants: 4 }),
    ).toEqual({ ok: false, reason: 'full' });
  });

  it('defaults capacity to 1 when maxParticipants is null', () => {
    expect(
      canPlayerBookSlot({ tier: 'public', playerHoldsClaim: false, isCycleMember: false, seatsTaken: 1, maxParticipants: null }),
    ).toEqual({ ok: false, reason: 'full' });
  });

  it('priority tier: only a claim-holder may book', () => {
    expect(canPlayerBookSlot({ tier: 'priority', playerHoldsClaim: true, isCycleMember: false, ...seat })).toEqual({ ok: true });
    expect(canPlayerBookSlot({ tier: 'priority', playerHoldsClaim: false, isCycleMember: false, ...seat })).toEqual({
      ok: false,
      reason: 'priority_restricted',
    });
  });

  it('members tier: only a cycle member may book', () => {
    expect(canPlayerBookSlot({ tier: 'members', playerHoldsClaim: false, isCycleMember: true, ...seat })).toEqual({ ok: true });
    expect(canPlayerBookSlot({ tier: 'members', playerHoldsClaim: false, isCycleMember: false, ...seat })).toEqual({
      ok: false,
      reason: 'members_only',
    });
  });

  it('hidden tier: nobody may self-book', () => {
    expect(canPlayerBookSlot({ tier: 'hidden', playerHoldsClaim: true, isCycleMember: true, ...seat })).toEqual({
      ok: false,
      reason: 'not_released',
    });
  });

  it('public tier with capacity: allowed', () => {
    expect(canPlayerBookSlot({ tier: 'public', playerHoldsClaim: false, isCycleMember: false, ...seat })).toEqual({ ok: true });
  });
});
