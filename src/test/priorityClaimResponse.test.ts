import { describe, it, expect } from 'vitest';
import {
  evaluatePriorityClaimResponse,
  type PriorityClaimResponseInput,
} from '../../supabase/functions/_shared/priority-claim-response.ts';

const NOW = new Date('2026-06-10T12:00:00.000Z');
const FUTURE = '2026-06-20T12:00:00.000Z';
const PAST = '2026-06-01T12:00:00.000Z';

const base: PriorityClaimResponseInput = {
  action: 'accept',
  claimStatus: 'pending',
  priorityWindowEndsAt: FUTURE,
  seatsTaken: 0,
  maxParticipants: 4,
  now: NOW,
};

describe('evaluatePriorityClaimResponse', () => {
  it('accept commits when pending, window open, and capacity remains', () => {
    expect(evaluatePriorityClaimResponse(base)).toEqual({ ok: true, status: 'claimed' });
  });

  it('decline releases when pending and window open', () => {
    expect(evaluatePriorityClaimResponse({ ...base, action: 'decline' })).toEqual({
      ok: true,
      status: 'declined',
    });
  });

  it('rejects when the claim was already responded to', () => {
    expect(evaluatePriorityClaimResponse({ ...base, claimStatus: 'claimed' })).toEqual({
      ok: false,
      reason: 'already_responded',
    });
    expect(evaluatePriorityClaimResponse({ ...base, claimStatus: 'declined' })).toEqual({
      ok: false,
      reason: 'already_responded',
    });
  });

  it('rejects accept/decline once the priority window has expired', () => {
    expect(evaluatePriorityClaimResponse({ ...base, priorityWindowEndsAt: PAST })).toEqual({
      ok: false,
      reason: 'window_expired',
    });
    expect(
      evaluatePriorityClaimResponse({ ...base, action: 'decline', priorityWindowEndsAt: PAST }),
    ).toEqual({ ok: false, reason: 'window_expired' });
  });

  it('blocks accept when the slot is already full', () => {
    expect(evaluatePriorityClaimResponse({ ...base, seatsTaken: 4, maxParticipants: 4 })).toEqual({
      ok: false,
      reason: 'slot_full',
    });
  });

  it('defaults capacity to 1 when maxParticipants is null', () => {
    expect(evaluatePriorityClaimResponse({ ...base, seatsTaken: 1, maxParticipants: null })).toEqual({
      ok: false,
      reason: 'slot_full',
    });
  });

  it('a window with no end date never expires', () => {
    expect(evaluatePriorityClaimResponse({ ...base, priorityWindowEndsAt: null })).toEqual({
      ok: true,
      status: 'claimed',
    });
  });
});
