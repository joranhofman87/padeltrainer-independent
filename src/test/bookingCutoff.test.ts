// @vitest-environment node
// The booking-cutoff check used by the PUBLIC/GUEST checkout edge functions.
//
// Registered players are covered by can_book_slot (trigger + RPC + edge pre-check). Guests are
// not — book_guest_*_for_payment take no user id — so this is the only thing standing between a
// public checkout and a session that closed an hour ago.
import { describe, it, expect, vi } from 'vitest';
import {
  assertSlotsOutsideBookingCutoff,
  type CutoffCheckClient,
} from '../../supabase/functions/_shared/booking-cutoff.ts';

const S1 = '01000000-0000-0000-0000-000000000001';
const S2 = '01000000-0000-0000-0000-000000000002';
const S3 = '01000000-0000-0000-0000-000000000003';

/** blocked: the set of slot ids the RPC should report as inside their cutoff. */
const client = (opts: { blocked?: string[]; error?: { code?: string; message?: string } } = {}) => {
  const rpc = vi.fn(async (_fn: string, args: Record<string, unknown>) => {
    if (opts.error) return { data: null, error: opts.error };
    return { data: (opts.blocked ?? []).includes(args.p_slot_id as string), error: null };
  });
  return { c: { rpc } as unknown as CutoffCheckClient, rpc };
};

describe('assertSlotsOutsideBookingCutoff', () => {
  it('allows when no slot is inside its cutoff', async () => {
    const { c, rpc } = client();
    expect(await assertSlotsOutsideBookingCutoff(c, [S1, S2])).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('refuses a single slot inside its cutoff, naming it', async () => {
    const { c } = client({ blocked: [S1] });
    expect(await assertSlotsOutsideBookingCutoff(c, [S1]))
      .toEqual({ ok: false, reason: 'booking_cutoff', slotId: S1 });
  });

  it('refuses a CYCLE when ANY one slot is inside the cutoff', async () => {
    // selling four sessions and quietly dropping tomorrow's would be worse than refusing
    const { c } = client({ blocked: [S3] });
    expect(await assertSlotsOutsideBookingCutoff(c, [S1, S2, S3]))
      .toEqual({ ok: false, reason: 'booking_cutoff', slotId: S3 });
  });

  it('stops at the FIRST blocked slot rather than probing the rest', async () => {
    const { c, rpc } = client({ blocked: [S1, S2, S3] });
    await assertSlotsOutsideBookingCutoff(c, [S1, S2, S3]);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('passes slot ids only — the tenant is never sent from here', async () => {
    // the whole point: academy/trainer come off the slot inside the RPC, so a caller cannot
    // name a laxer tenant
    const { c, rpc } = client();
    await assertSlotsOutsideBookingCutoff(c, [S1]);
    expect(rpc).toHaveBeenCalledWith('is_slot_within_player_booking_cutoff', { p_slot_id: S1 });
    expect(Object.keys(rpc.mock.calls[0][1])).toEqual(['p_slot_id']);
  });

  it('THROWS on a real RPC error rather than selling the booking', async () => {
    const { c } = client({ error: { code: '42501', message: 'permission denied' } });
    await expect(assertSlotsOutsideBookingCutoff(c, [S1])).rejects.toThrow(/permission denied/);
  });

  it('degrades OPEN only for a genuinely missing RPC, and says so', async () => {
    // deploy-order tolerance, matching create-mollie-payment's tier pre-check. Deliberate
    // asymmetry: a blocked public checkout costs real bookings, a late one staff can cancel.
    for (const error of [
      { code: 'PGRST202', message: 'Could not find the function' },
      { code: '42883', message: 'function does not exist' },
      { message: 'is_slot_within_player_booking_cutoff missing' },
    ]) {
      const { c } = client({ error });
      const r = await assertSlotsOutsideBookingCutoff(c, [S1]);
      expect(r.ok).toBe(true);
      expect(r).toHaveProperty('degraded', 'rpc_missing');
    }
  });

  it('treats anything other than TRUE as "not blocked here", never as a verdict', async () => {
    // the RPC owns the decision; this helper must not infer one from a soft value
    for (const data of [false, null, undefined, 0, '']) {
      const rpc = vi.fn(async () => ({ data, error: null }));
      const r = await assertSlotsOutsideBookingCutoff({ rpc } as unknown as CutoffCheckClient, [S1]);
      expect(r).toEqual({ ok: true });
    }
  });

  it('allows an empty slot list without calling anything', async () => {
    const { c, rpc } = client({ blocked: [S1] });
    expect(await assertSlotsOutsideBookingCutoff(c, [])).toEqual({ ok: true });
    expect(rpc).not.toHaveBeenCalled();
  });
});
