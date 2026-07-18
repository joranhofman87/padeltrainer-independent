import { describe, it, expect } from 'vitest';
import { isGuestForBadge } from './bookingLoginFlags';

describe('isGuestForBadge (Phase 3.5c)', () => {
  const flags = new Map<string, boolean>([['b1', true], ['b2', false]]);

  it('person-level when known: login holder → not guest, accountless → guest (seat ignored)', () => {
    expect(isGuestForBadge(flags, 'b1', true)).toBe(false); // merged login holder on a guest seat
    expect(isGuestForBadge(flags, 'b2', false)).toBe(true); // accountless on a linker-stamped profile seat
  });

  it('falls back to the seat value when the booking is unknown (pre-deploy / unauthorized)', () => {
    expect(isGuestForBadge(flags, 'b9', true)).toBe(true);
    expect(isGuestForBadge(flags, 'b9', false)).toBe(false);
    expect(isGuestForBadge(flags, null, true)).toBe(true);
    expect(isGuestForBadge(flags, undefined, false)).toBe(false);
  });
});
