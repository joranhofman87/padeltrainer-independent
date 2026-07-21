// @vitest-environment node
// PR 9: the guest booking WhatsApp opt-in helper. Two properties carry the weight:
//
//   1. AN UNCHECKED BOX DOES NOTHING AT ALL — not even a lookup. Consent must be an action the
//      guest took, and "we only skipped the write" is not the same guarantee.
//   2. IT NEVER THROWS. It runs inside a paid-booking path; a consent write must not be able to
//      fail a purchase. Getting a session reminder is worth far less than completing the booking.
import { describe, it, expect, vi } from 'vitest';
import {
  recordGuestWhatsAppOptIn,
  type ConsentWriteClient,
} from '../../supabase/functions/_shared/guest-whatsapp-optin.ts';

const GUEST = '0b000000-0000-0000-0000-0000000000b1';
const PERSON = '0d000000-0000-0000-0000-0000000000d1';
const ACADEMY = '0a000000-0000-0000-0000-0000000000a1';

/** Minimal stand-in for the service-role client: person_links lookup + the rpc. */
const client = (opts: {
  personId?: string | null;
  linkError?: string;
  rpcResult?: unknown;
  rpcError?: string;
  rpcThrows?: boolean;
} = {}) => {
  const rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => {
    if (opts.rpcThrows) throw new Error('connection reset');
    // ?? would turn an explicitly-passed null back into a value and silently skip the
    // rejection path, so distinguish "not provided" from null by key presence.
    const data = 'rpcResult' in opts ? opts.rpcResult : 'contact-1';
    return { data, error: opts.rpcError ? { message: opts.rpcError } : null };
  });
  const from = vi.fn(() => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({
          data: opts.personId === null ? null : { person_id: opts.personId ?? PERSON },
          error: opts.linkError ? { message: opts.linkError } : null,
        }),
      }),
    }),
  }));
  return { client: { from, rpc } as unknown as ConsentWriteClient, from, rpc };
};

const base = {
  phone: '06 12345678',
  guestPlayerId: GUEST,
  academyProfileId: ACADEMY,
  source: 'public_booking',
};

describe('recordGuestWhatsAppOptIn', () => {
  it('records an opt-in with the SERVER-derived tenant and the typed phone', async () => {
    const { client: c, rpc } = client();
    const r = await recordGuestWhatsAppOptIn(c, { ...base, optIn: true });
    expect(r).toEqual({ ok: true, contactId: 'contact-1' });
    expect(rpc).toHaveBeenCalledWith('record_whatsapp_optin', {
      p_person_id: PERSON,
      p_phone: '06 12345678',       // free text; the RPC normalizes and rejects what it cannot
      p_academy_profile_id: ACADEMY,
      p_trainer_id: null,
      p_source: 'public_booking',
    });
  });

  it('an UNCHECKED box does nothing — no lookup, no write', async () => {
    for (const optIn of [false, undefined]) {
      const { client: c, from, rpc } = client();
      expect(await recordGuestWhatsAppOptIn(c, { ...base, optIn })).toEqual({ ok: false, reason: 'not_requested' });
      expect(from).not.toHaveBeenCalled();   // not even a person lookup
      expect(rpc).not.toHaveBeenCalled();
    }
  });

  it('refuses without a phone or a tenant rather than writing a partial consent', async () => {
    const { client: c, rpc } = client();
    expect(await recordGuestWhatsAppOptIn(c, { ...base, optIn: true, phone: '   ' }))
      .toEqual({ ok: false, reason: 'no_phone' });
    expect(await recordGuestWhatsAppOptIn(c, { ...base, optIn: true, academyProfileId: null }))
      .toEqual({ ok: false, reason: 'no_tenant' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('reports a REJECTED opt-in distinctly — the RPC fails closed on a bad number', async () => {
    // NULL back from the RPC means it would not guess at an unnormalizable number. That is a
    // normal outcome, not an error, and must not be logged as one.
    const { client: c } = client({ rpcResult: null });
    expect(await recordGuestWhatsAppOptIn(c, { ...base, optIn: true })).toEqual({ ok: false, reason: 'rejected' });
  });

  it('NEVER THROWS — a failed consent write must not break a paid booking', async () => {
    const thrown = await recordGuestWhatsAppOptIn(client({ rpcThrows: true }).client, { ...base, optIn: true });
    expect(thrown).toMatchObject({ ok: false, reason: 'error', detail: 'connection reset' });

    const rpcErr = await recordGuestWhatsAppOptIn(client({ rpcError: 'boom' }).client, { ...base, optIn: true });
    expect(rpcErr).toMatchObject({ ok: false, reason: 'error', detail: 'boom' });

    const linkErr = await recordGuestWhatsAppOptIn(client({ linkError: 'nope' }).client, { ...base, optIn: true });
    expect(linkErr).toMatchObject({ ok: false, reason: 'error', detail: 'nope' });
  });

  it('stops when the guest has no person link, instead of guessing a person', async () => {
    const { client: c, rpc } = client({ personId: null });
    expect(await recordGuestWhatsAppOptIn(c, { ...base, optIn: true })).toEqual({ ok: false, reason: 'no_person' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('passes a trainer-scoped tenant through when there is no academy', async () => {
    const { client: c, rpc } = client();
    await recordGuestWhatsAppOptIn(c, {
      ...base, optIn: true, academyProfileId: null, trainerId: '0c000000-0000-0000-0000-0000000000c1',
    });
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_academy_profile_id: null,
      p_trainer_id: '0c000000-0000-0000-0000-0000000000c1',
    });
  });
});
