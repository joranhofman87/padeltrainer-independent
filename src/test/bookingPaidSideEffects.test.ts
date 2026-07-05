// @vitest-environment node
// runBookingPaidSideEffects — the guest confirmation email + hoisted Slack ping
// (public-booking audit P1-5 / cart PR 3).
//
// Before this change the email AND the payment_received Slack ping both lived inside
// `if (booking?.profiles?.email)`, whose join is player_id-keyed — guest bookings
// (player_id NULL) silently got neither. Now: player bookings keep the player template,
// guest bookings get the invoice email (send-invoice-email, PDF itemizes all sessions),
// and Slack pings for both.
//
// The helper takes the supabase client as a parameter and its only remote import is
// type-only, so we drive the REAL helper with a hand-rolled fake — no module mocks.
import { describe, it, expect, vi } from 'vitest';
import { runBookingPaidSideEffects } from '../../supabase/functions/_shared/mollie-booking-paid-side-effects.ts';

type FakeOpts = {
  booking: Record<string, unknown> | null;
  /** auto-create-invoice invoke response body (null = empty response). */
  invoiceInvokeData?: Record<string, unknown> | null;
  /** row returned by the invoices .overlaps fallback lookup. */
  invoiceFallbackRow?: { id: string } | null;
};

/**
 * Chainable query fake: every builder method returns the chain; awaiting it resolves
 * {data: thenData}; .single()/.maybeSingle() resolve {data: rowData}. One chain per
 * from(table) call, so per-table data covers every query the helper runs.
 */
function chain(thenData: unknown, rowData: unknown = thenData) {
  const target = () => {};
  const self: unknown = new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then') {
        return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
          Promise.resolve({ data: thenData, error: null }).then(res, rej);
      }
      if (prop === 'single' || prop === 'maybeSingle') {
        return () => Promise.resolve({ data: rowData, error: null });
      }
      return () => self;
    },
  });
  return self;
}

function makeFakeSupabase(opts: FakeOpts) {
  const invoke = vi.fn(async (name: string, _opts?: { body?: Record<string, unknown> }) => {
    if (name === 'auto-create-invoice') return { data: opts.invoiceInvokeData ?? null, error: null };
    return { data: null, error: null };
  });
  const from = vi.fn((table: string) => {
    switch (table) {
      case 'bookings':
        // finalizePriorityClaims awaits the chain (thenData: no paid rows to settle);
        // the email block ends in .single() (rowData: the booking under test).
        return chain([], opts.booking);
      case 'invoices':
        return chain(null, opts.invoiceFallbackRow ?? null);
      case 'trainer_profiles':
        return chain(null, { user_id: 'user-1' });
      case 'profiles':
        return chain(null, { full_name: 'Trainer T' });
      default:
        return chain(null, null);
    }
  });
  return { supabase: { functions: { invoke }, from }, invoke };
}

const SLOT = { start_time: '2027-01-01T10:00:00Z', end_time: '2027-01-01T11:00:00Z', trainer_id: 'tp-1', locations: { name: 'Hal 1', city: 'Utrecht' } };

const guestBooking = {
  id: 'B1',
  player_id: null,
  guest_player_id: 'G1',
  availability_slots: SLOT,
  profiles: null,
  guest_players: { full_name: 'Gast Speler' },
};

const playerBooking = {
  id: 'B1',
  player_id: 'P1',
  guest_player_id: null,
  availability_slots: SLOT,
  profiles: { full_name: 'Player P', email: 'p@example.com' },
  guest_players: null,
};

const run = (supabase: unknown, notifySlackError = vi.fn(async (_fn: string, _msg: string, _ctx?: Record<string, unknown>) => {})) =>
  runBookingPaidSideEffects({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: supabase as any,
    bookingIds: ['B1', 'B2'],
    paymentAmountValue: '25.00',
    source: 'test',
    logStep: () => {},
    notifySlackError,
  }).then(() => notifySlackError);

const callsTo = (
  invoke: { mock: { calls: [string, ({ body?: Record<string, unknown> } | undefined)?][] } },
  name: string,
) => invoke.mock.calls.filter((c) => c[0] === name);

describe('runBookingPaidSideEffects — guest confirmation email (P1-5)', () => {
  it('guest booking: sends the invoice email exactly once, with the minted invoiceId', async () => {
    const { supabase, invoke } = makeFakeSupabase({
      booking: guestBooking,
      invoiceInvokeData: { success: true, invoiceId: 'INV-1' },
    });
    await run(supabase);
    const sends = callsTo(invoke, 'send-invoice-email');
    expect(sends).toHaveLength(1);
    expect(sends[0][1]).toMatchObject({ body: { invoiceId: 'INV-1' } });
    // the player template must NOT fire for a guest
    expect(callsTo(invoke, 'send-email')).toHaveLength(0);
  });

  it('guest booking: falls back to the overlapping invoice when the invoke response is empty', async () => {
    const { supabase, invoke } = makeFakeSupabase({
      booking: guestBooking,
      invoiceInvokeData: null,
      invoiceFallbackRow: { id: 'INV-2' },
    });
    await run(supabase);
    const sends = callsTo(invoke, 'send-invoice-email');
    expect(sends).toHaveLength(1);
    expect(sends[0][1]).toMatchObject({ body: { invoiceId: 'INV-2' } });
  });

  it('guest booking with NO resolvable invoice: no email, but an alert (money landed silently)', async () => {
    const { supabase, invoke } = makeFakeSupabase({
      booking: guestBooking,
      invoiceInvokeData: null,
      invoiceFallbackRow: null,
    });
    const notifySlackError = await run(supabase);
    expect(callsTo(invoke, 'send-invoice-email')).toHaveLength(0);
    const alerts = notifySlackError.mock.calls.map((c) => String(c[1]));
    expect(alerts.some((m) => m.includes('no invoice'))).toBe(true);
  });

  it('player booking: keeps the player confirmation template, never the invoice email', async () => {
    const { supabase, invoke } = makeFakeSupabase({
      booking: playerBooking,
      invoiceInvokeData: { success: true, invoiceId: 'INV-1' },
    });
    await run(supabase);
    expect(callsTo(invoke, 'send-email')).toHaveLength(1);
    expect(callsTo(invoke, 'send-invoice-email')).toHaveLength(0);
  });
});

describe('runBookingPaidSideEffects — Slack payment_received hoisted out of the email guard', () => {
  it('pings payment_received for a GUEST booking (used to be silently skipped)', async () => {
    const { supabase, invoke } = makeFakeSupabase({
      booking: guestBooking,
      invoiceInvokeData: { success: true, invoiceId: 'INV-1' },
    });
    await run(supabase);
    const slack = callsTo(invoke, 'slack-notify');
    expect(slack).toHaveLength(1);
    expect(slack[0][1]).toMatchObject({
      body: { event: 'payment_received', data: { player: 'Gast Speler', trainer: 'Trainer T', bookings: 2 } },
    });
  });

  it('still pings payment_received for a player booking', async () => {
    const { supabase, invoke } = makeFakeSupabase({
      booking: playerBooking,
      invoiceInvokeData: { success: true, invoiceId: 'INV-1' },
    });
    await run(supabase);
    const slack = callsTo(invoke, 'slack-notify');
    expect(slack).toHaveLength(1);
    expect(slack[0][1]).toMatchObject({
      body: { event: 'payment_received', data: { player: 'Player P' } },
    });
  });

  it('does not ping when the booking row cannot be read (nothing to report on)', async () => {
    const { supabase, invoke } = makeFakeSupabase({ booking: null, invoiceInvokeData: null });
    await run(supabase);
    expect(callsTo(invoke, 'slack-notify')).toHaveLength(0);
    expect(callsTo(invoke, 'send-invoice-email')).toHaveLength(0);
  });
});
