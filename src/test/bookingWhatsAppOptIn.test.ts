// @vitest-environment node
// PR 9: the booking opt-in SEQUENCE. Extracted from BookLesson precisely because the page has
// no test harness and the ordering is what went wrong once — the profile write happened before
// the RPC had validated the number, so an unnormalizable phone could land on the account while
// the opt-in itself correctly failed closed.
import { describe, it, expect, vi } from 'vitest';
import { recordBookingWhatsAppOptIn } from '@/lib/bookingWhatsAppOptIn';

const SLOT = '01000000-0000-0000-0000-000000000011';

const deps = (over: Partial<{
  data: unknown;
  rpcError: string;
  profileError: string;
  rpcThrows: boolean;
}> = {}) => {
  const calls: string[] = [];
  const recordOptIn = vi.fn(async () => {
    calls.push('rpc');
    if (over.rpcThrows) throw new Error('offline');
    return {
      data: 'data' in over ? over.data : 'contact-1',
      error: over.rpcError ? { message: over.rpcError } : null,
    };
  });
  const savePhoneToProfile = vi.fn(async () => {
    calls.push('profile');
    return { error: over.profileError ? { message: over.profileError } : null };
  });
  const onError = vi.fn();
  return { d: { recordOptIn, savePhoneToProfile, onError }, calls, recordOptIn, savePhoneToProfile, onError };
};

const input = (over: Partial<Parameters<typeof recordBookingWhatsAppOptIn>[0]> = {}) => ({
  optIn: true, slotId: SLOT, phone: '0612345678', hasProfilePhone: false, ...over,
});

describe('recordBookingWhatsAppOptIn', () => {
  it('records consent FIRST, then saves the typed number', async () => {
    const { d, calls } = deps();
    expect(await recordBookingWhatsAppOptIn(input(), d)).toBe('recorded_and_saved');
    // the order IS the contract — the RPC is what validates the number
    expect(calls).toEqual(['rpc', 'profile']);
  });

  it('does NOT touch the profile when the RPC refuses the number', async () => {
    // the regression: a number too malformed to message is too malformed to store, and writing
    // first would leave the profile holding one the opt-in correctly rejected
    const { d, savePhoneToProfile } = deps({ data: null });
    expect(await recordBookingWhatsAppOptIn(input(), d)).toBe('rejected');
    expect(savePhoneToProfile).not.toHaveBeenCalled();
  });

  it('does NOT touch the profile when it already had a number', async () => {
    // that path never shows the input, so the copy never mentions storing anything
    const { d, savePhoneToProfile } = deps();
    expect(await recordBookingWhatsAppOptIn(input({ hasProfilePhone: true }), d)).toBe('recorded');
    expect(savePhoneToProfile).not.toHaveBeenCalled();
  });

  it('does nothing at all when unticked, slotless or numberless', async () => {
    for (const over of [{ optIn: false }, { slotId: undefined }, { phone: '   ' }]) {
      const { d, recordOptIn, savePhoneToProfile } = deps();
      expect(await recordBookingWhatsAppOptIn(input(over), d)).toBe('skipped');
      expect(recordOptIn).not.toHaveBeenCalled();
      expect(savePhoneToProfile).not.toHaveBeenCalled();
    }
  });

  it('NEVER THROWS — a consent write must not be able to break a booking', async () => {
    for (const over of [{ rpcThrows: true }, { rpcError: 'denied' }, { profileError: 'nope' }]) {
      const { d, onError } = deps(over);
      await expect(recordBookingWhatsAppOptIn(input(), d)).resolves.toBe('failed');
      expect(onError).toHaveBeenCalled();
    }
  });

  it('reports a profile-save failure without losing the consent that DID land', async () => {
    // the RPC already succeeded, so the consent is real even though the convenience write failed
    const { d, recordOptIn } = deps({ profileError: 'rls' });
    expect(await recordBookingWhatsAppOptIn(input(), d)).toBe('failed');
    expect(recordOptIn).toHaveBeenCalled();
  });

  it('trims before deciding there is a number to use', async () => {
    const { d, recordOptIn } = deps();
    await recordBookingWhatsAppOptIn(input({ phone: '  0612345678  ' }), d);
    expect(recordOptIn).toHaveBeenCalledWith(SLOT, '0612345678');
  });
});
