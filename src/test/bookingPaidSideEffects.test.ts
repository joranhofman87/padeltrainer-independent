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
  /** rows for the staff-notification .in() bookings fetch (default: none). */
  staffBookings?: Record<string, unknown>[];
  /** academy_managers rows (user_id) for the involved academies. */
  managers?: { user_id: string }[];
  /** trainer_profiles rows (id, user_id) for the involved trainers. */
  trainerProfiles?: { id: string; user_id: string | null }[];
  /** profiles rows (user_id, email, full_name) for batch email resolution. */
  profileRows?: { user_id: string; email: string | null; full_name: string | null }[];
};

/**
 * Chainable query fake: every builder method returns the chain; awaiting it resolves
 * {data: thenData}; .single()/.maybeSingle() resolve {data: rowData}. One chain per
 * from(table) call, so per-table data covers every query the helper runs.
 */
function chain(thenData: unknown, rowData: unknown = thenData) {
  const target = () => {};
  // .in(col, vals) filters are honored when the rows carry that column (the staff
  // notification block resolves managers and trainers with separate .in() reads on
  // the SAME table, so a table-level fake would leak rows across queries).
  const inFilters: Array<[string, unknown[]]> = [];
  const applyFilters = (data: unknown): unknown => {
    if (!Array.isArray(data) || inFilters.length === 0) return data;
    return data.filter((row) =>
      inFilters.every(([col, vals]) =>
        row && typeof row === 'object' && col in (row as Record<string, unknown>)
          ? vals.includes((row as Record<string, unknown>)[col])
          : true,
      ),
    );
  };
  const self: unknown = new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then') {
        return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
          Promise.resolve({ data: applyFilters(thenData), error: null }).then(res, rej);
      }
      if (prop === 'single' || prop === 'maybeSingle') {
        return () => Promise.resolve({ data: rowData, error: null });
      }
      if (prop === 'in') {
        return (col: string, vals: unknown[]) => {
          inFilters.push([col, vals]);
          return self;
        };
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
        // Awaited chains (finalizePriorityClaims + the staff .in() fetch) resolve
        // thenData; the email block ends in .single() (rowData: booking under test).
        return chain(opts.staffBookings ?? [], opts.booking);
      case 'invoices':
        return chain(null, opts.invoiceFallbackRow ?? null);
      case 'academy_managers':
        return chain(opts.managers ?? [], null);
      case 'trainer_profiles':
        return chain(opts.trainerProfiles ?? [], { user_id: 'user-1' });
      case 'profiles':
        return chain(opts.profileRows ?? [], { full_name: 'Trainer T' });
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

// ---------------------------------------------------------------------------
// Staff booking notifications (owner request 2026-07-06): the trainer hears
// about every paid public booking WITHOUT the price; academy managers get the
// amount; a trainer whose address is already an academy recipient is deduped.
// ---------------------------------------------------------------------------

const STAFF_SLOT = {
  start_time: '2027-01-01T10:00:00Z',
  end_time: '2027-01-01T11:00:00Z',
  trainer_id: 'tp-1',
  academy_profile_id: null as string | null,
  cyclus_name: 'Zomertraining',
  locations: { name: 'Hal 1' },
};

const staffBooking = (over: Partial<typeof STAFF_SLOT> = {}) => ({
  id: 'B1',
  availability_slots: { ...STAFF_SLOT, ...over },
});

const staffEmailCalls = (invoke: ReturnType<typeof makeFakeSupabase>['invoke']) =>
  callsTo(invoke, 'send-email').filter(
    (c) => (c[1]?.body as { type?: string } | undefined)?.type === 'new_public_booking_admin',
  );

describe('runBookingPaidSideEffects — staff booking notifications', () => {
  it('emails the trainer WITHOUT any amount (bookings only)', async () => {
    const { supabase, invoke } = makeFakeSupabase({
      booking: guestBooking,
      invoiceInvokeData: { invoiceId: 'INV-1' },
      staffBookings: [staffBooking()],
      trainerProfiles: [{ id: 'tp-1', user_id: 'user-1' }],
      profileRows: [{ user_id: 'user-1', email: 'trainer@example.com', full_name: 'Trainer T' }],
    });
    await run(supabase);
    const staff = staffEmailCalls(invoke);
    expect(staff).toHaveLength(1);
    const body = staff[0][1]!.body as { to: string; data: Record<string, unknown> };
    expect(body.to).toBe('trainer@example.com');
    expect(body.data.amount).toBeUndefined();
    expect(JSON.stringify(body.data)).not.toContain('25.00');
    expect((body.data.sessions as unknown[]).length).toBe(1);
    expect(body.data.playerName).toBe('Gast Speler');
  });

  it('emails academy managers WITH the paid amount, alongside the price-less trainer email', async () => {
    const { supabase, invoke } = makeFakeSupabase({
      booking: guestBooking,
      invoiceInvokeData: { invoiceId: 'INV-1' },
      staffBookings: [staffBooking({ academy_profile_id: 'AC-1' })],
      managers: [{ user_id: 'mgr-1' }],
      trainerProfiles: [{ id: 'tp-1', user_id: 'user-1' }],
      profileRows: [
        { user_id: 'mgr-1', email: 'manager@academy.nl', full_name: 'Manager M' },
        { user_id: 'user-1', email: 'trainer@example.com', full_name: 'Trainer T' },
      ],
    });
    await run(supabase);
    const staff = staffEmailCalls(invoke);
    expect(staff).toHaveLength(2);
    const byTo = new Map(staff.map((c) => [(c[1]!.body as { to: string }).to, c[1]!.body as { data: Record<string, unknown> }]));
    expect(byTo.get('manager@academy.nl')!.data.amount).toBe('€25.00');
    expect(byTo.get('trainer@example.com')!.data.amount).toBeUndefined();
  });

  it('dedupes: a trainer who is also an academy manager gets ONLY the academy version', async () => {
    const { supabase, invoke } = makeFakeSupabase({
      booking: guestBooking,
      invoiceInvokeData: { invoiceId: 'INV-1' },
      staffBookings: [staffBooking({ academy_profile_id: 'AC-1' })],
      managers: [{ user_id: 'user-1' }],
      trainerProfiles: [{ id: 'tp-1', user_id: 'user-1' }],
      profileRows: [{ user_id: 'user-1', email: 'solo@academy.nl', full_name: 'Solo S' }],
    });
    await run(supabase);
    const staff = staffEmailCalls(invoke);
    expect(staff).toHaveLength(1);
    const body = staff[0][1]!.body as { to: string; data: Record<string, unknown> };
    expect(body.to).toBe('solo@academy.nl');
    expect(body.data.amount).toBe('€25.00');
  });

  it('sends no staff email when the bookings fetch is empty (and existing flows stay intact)', async () => {
    const { supabase, invoke } = makeFakeSupabase({
      booking: guestBooking,
      invoiceInvokeData: { invoiceId: 'INV-1' },
    });
    await run(supabase);
    expect(staffEmailCalls(invoke)).toHaveLength(0);
  });
});

describe('runBookingPaidSideEffects — player confirmation invoke fixed (type, not template)', () => {
  it("sends type 'booking_confirmation' with the fields the template renders", async () => {
    const { supabase, invoke } = makeFakeSupabase({ booking: playerBooking });
    await run(supabase);
    const confirmations = callsTo(invoke, 'send-email').filter(
      (c) => (c[1]?.body as { type?: string } | undefined)?.type === 'booking_confirmation',
    );
    expect(confirmations).toHaveLength(1);
    const body = confirmations[0][1]!.body as Record<string, unknown>;
    expect(body.template).toBeUndefined();
    const data = body.data as Record<string, unknown>;
    expect(data.price).toBe('25.00');
    expect(data.lessonTitle).toBeTruthy();
    expect(data.trainerName).toBe('Trainer T');
  });
});
