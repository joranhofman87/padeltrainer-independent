// @vitest-environment node
// runBookingPaidSideEffects — the hoisted Slack ping + staff notifications.
//
// The player-facing PAYMENT CONFIRMATION now ENQUEUES onto the notification outbox
// (sendPlayerBookingConfirmation, tested in bookingConfirmationEmail.test.ts). In these
// tests the fake's staff-bookings fetch returns rows with no payer identity, so the player
// helper returns no_payer WITHOUT enqueuing — which is why the blocks below assert the SLACK
// ping and the STAFF fan-out (booking_confirmed_staff enqueues, PR 6b), not the player email.
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
  /** academy_managers rows (user_id + academy) for the involved academies. */
  managers?: { user_id: string; academy_profile_id: string }[];
  /** trainer_profiles rows (id, user_id) for the involved trainers. */
  trainerProfiles?: { id: string; user_id: string | null }[];
  /** profiles rows (user_id, full_name) — staff deliver via the persons.email account fallback. */
  profileRows?: { user_id: string; full_name: string | null }[];
  /** error to return from enqueue_notification (default: success). */
  enqueueError?: string;
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
  // The staff fan-out (PR 6b) + the player confirmation (PR 6a) enqueue via rpc.
  const rpc = vi.fn(async (name: string, _params?: Record<string, unknown>) => {
    if (name === 'enqueue_notification') {
      if (opts.enqueueError) return { data: null, error: { message: opts.enqueueError } };
      return { data: [{ outbox_id: 'ob', channel: 'email', status: 'pending', skip_reason: null }], error: null };
    }
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
  return { supabase: { functions: { invoke }, from, rpc }, invoke, rpc };
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
    molliePaymentId: 'tr_test',
    source: 'test',
    logStep: () => {},
    notifySlackError,
  }).then(() => notifySlackError);

const callsTo = (
  invoke: { mock: { calls: [string, ({ body?: Record<string, unknown> } | undefined)?][] } },
  name: string,
) => invoke.mock.calls.filter((c) => c[0] === name);

// NOTE: the player/guest confirmation EMAIL (unified helper sendPlayerBookingConfirmation)
// is covered by bookingConfirmationEmail.test.ts. In this Node env the helper short-circuits
// (no RESEND_API_KEY) so it emits no email and no alert — these blocks cover the parts of
// runBookingPaidSideEffects that still fire here: the Slack ping and staff notifications.

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
// Staff booking notifications (owner request 2026-07-06), now via the OUTBOX
// (booking_confirmed_staff, PR 6b): the trainer hears about every paid public
// booking WITHOUT the price; academy managers get the amount; a trainer who is
// also an academy manager (same account) is deduped. Each row is tenant-scoped
// and enqueued via rpc — the legacy send-email direct send is GONE (no double-send).
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


const staffEnqueues = (rpc: ReturnType<typeof makeFakeSupabase>['rpc']) =>
  (rpc.mock.calls as Array<[string, Record<string, unknown>]>).filter(
    (c) => c[0] === 'enqueue_notification' && c[1]?.p_event_key === 'booking_confirmed_staff',
  );
const legacyStaffEmails = (invoke: ReturnType<typeof makeFakeSupabase>['invoke']) =>
  callsTo(invoke, 'send-email').filter(
    (c) => (c[1]?.body as { type?: string } | undefined)?.type === 'new_public_booking_admin',
  );

describe('runBookingPaidSideEffects — staff booking notifications (outbox)', () => {
  it('enqueues the trainer WITHOUT any amount (bookings only), tenant-scoped to the trainer — and NO legacy send-email', async () => {
    const { supabase, invoke, rpc } = makeFakeSupabase({
      booking: guestBooking,
      invoiceInvokeData: { invoiceId: 'INV-1' },
      staffBookings: [staffBooking()], // academy_profile_id null → trainer-only
      trainerProfiles: [{ id: 'tp-1', user_id: 'user-1' }],
      profileRows: [{ user_id: 'user-1', full_name: 'Trainer T' }],
    });
    await run(supabase);
    const staff = staffEnqueues(rpc);
    expect(staff).toHaveLength(1);
    const p = staff[0][1] as { p_recipient_user_id: string; p_tenant_trainer_id: string | null; p_tenant_academy_profile_id: string | null; p_related_booking_ids: string[]; p_related_payment_id: string; p_payload: { subject: string; html: string } };
    expect(p.p_recipient_user_id).toBe('user-1');
    expect(p.p_tenant_trainer_id).toBe('tp-1');
    expect(p.p_tenant_academy_profile_id).toBeNull();
    expect(p.p_related_payment_id).toBe('tr_test'); // idempotency subject threaded through
    expect(p.p_related_booking_ids).toEqual(['B1', 'B2']);
    expect(p.p_payload.html).not.toContain('Amount paid');
    expect(p.p_payload.subject).toContain('Gast Speler');
    expect(legacyStaffEmails(invoke)).toHaveLength(0); // no double-send
  });

  it('enqueues academy managers WITH the paid amount (in the html), alongside the price-less trainer row', async () => {
    const { supabase, rpc } = makeFakeSupabase({
      booking: guestBooking,
      invoiceInvokeData: { invoiceId: 'INV-1' },
      staffBookings: [staffBooking({ academy_profile_id: 'AC-1' })],
      managers: [{ user_id: 'mgr-1', academy_profile_id: 'AC-1' }],
      trainerProfiles: [{ id: 'tp-1', user_id: 'user-1' }],
      profileRows: [
        { user_id: 'mgr-1', full_name: 'Manager M' },
        { user_id: 'user-1', full_name: 'Trainer T' },
      ],
    });
    await run(supabase);
    const staff = staffEnqueues(rpc);
    expect(staff).toHaveLength(2);
    const byUser = new Map(staff.map((c) => [(c[1] as { p_recipient_user_id: string }).p_recipient_user_id, c[1] as { p_tenant_academy_profile_id: string | null; p_tenant_trainer_id: string | null; p_payload: { html: string } }]));
    const mgr = byUser.get('mgr-1')!;
    expect(mgr.p_tenant_academy_profile_id).toBe('AC-1');
    expect(mgr.p_tenant_trainer_id).toBeNull();
    expect(mgr.p_payload.html).toContain('Amount paid');
    expect(mgr.p_payload.html).toContain('€25.00');
    const trn = byUser.get('user-1')!;
    expect(trn.p_tenant_trainer_id).toBe('tp-1');
    expect(trn.p_payload.html).not.toContain('Amount paid');
  });

  it('dedupes: a trainer who is also an academy manager (same account) gets ONLY the academy row', async () => {
    const { supabase, rpc } = makeFakeSupabase({
      booking: guestBooking,
      invoiceInvokeData: { invoiceId: 'INV-1' },
      staffBookings: [staffBooking({ academy_profile_id: 'AC-1' })],
      managers: [{ user_id: 'user-1', academy_profile_id: 'AC-1' }],
      trainerProfiles: [{ id: 'tp-1', user_id: 'user-1' }],
      profileRows: [{ user_id: 'user-1', full_name: 'Solo S' }],
    });
    await run(supabase);
    const staff = staffEnqueues(rpc);
    expect(staff).toHaveLength(1);
    const p = staff[0][1] as { p_recipient_user_id: string; p_tenant_academy_profile_id: string | null; p_payload: { html: string } };
    expect(p.p_recipient_user_id).toBe('user-1');
    expect(p.p_tenant_academy_profile_id).toBe('AC-1'); // the academy version (with amount)
    expect(p.p_payload.html).toContain('€25.00');
  });

  it('enqueues nothing when the bookings fetch is empty (existing flows stay intact)', async () => {
    const { supabase, rpc } = makeFakeSupabase({
      booking: guestBooking,
      invoiceInvokeData: { invoiceId: 'INV-1' },
    });
    await run(supabase);
    expect(staffEnqueues(rpc)).toHaveLength(0);
  });

  it('SECURITY: a malicious guest playerName is HTML-escaped in the enqueued staff email (no injection)', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    const { supabase, rpc } = makeFakeSupabase({
      booking: { ...guestBooking, guest_players: { full_name: evil } },
      invoiceInvokeData: { invoiceId: 'INV-1' },
      staffBookings: [staffBooking()],
      trainerProfiles: [{ id: 'tp-1', user_id: 'user-1' }],
      profileRows: [{ user_id: 'user-1', full_name: 'Trainer T' }],
    });
    await run(supabase);
    const p = staffEnqueues(rpc)[0][1] as { p_payload: { html: string } };
    expect(p.p_payload.html).not.toContain(evil);
    expect(p.p_payload.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('an enqueue error is surfaced (Slack alert), never swallowed', async () => {
    const notify = vi.fn(async (_fn: string, _msg: string, _ctx?: Record<string, unknown>) => {});
    const { supabase } = makeFakeSupabase({
      booking: guestBooking,
      invoiceInvokeData: { invoiceId: 'INV-1' },
      staffBookings: [staffBooking()],
      trainerProfiles: [{ id: 'tp-1', user_id: 'user-1' }],
      profileRows: [{ user_id: 'user-1', full_name: 'Trainer T' }],
      enqueueError: 'boom',
    });
    await run(supabase, notify);
    expect(notify.mock.calls.some((c) => String(c[1]).includes('staff booking notifications could not be enqueued'))).toBe(true);
  });
});

