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
  /** resolver answers [] with NO error — the idempotent no-op. Produced NO row. */
  enqueueEmpty?: boolean;
  /** resolver answers a 'skipped' row with NO error — a real row, but not a delivery. */
  enqueueSkipped?: boolean;
  /** make the booking-CONTEXT .single() resolve an ERROR (broken embed / RLS change). */
  bookingContextError?: string;
  /** make every query on this table THROW (network/isolate fault), not resolve an error. */
  throwOnTable?: string;
  /** make ONLY .single()/.maybeSingle() throw for this table — isolates the display-name
   *  lookup (which uses .single()) from the staff fan-out's .in() reads on the same table. */
  throwOnSingle?: string;
};

/**
 * Chainable query fake: every builder method returns the chain; awaiting it resolves
 * {data: thenData}; .single()/.maybeSingle() resolve {data: rowData}. One chain per
 * from(table) call, so per-table data covers every query the helper runs.
 */
function chain(
  thenData: unknown,
  rowData: unknown = thenData,
  extra: { rowError?: string; throws?: boolean; throwsSingle?: boolean; onInsert?: (payload: unknown) => void } = {},
) {
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
        if (extra.throws) {
          return (_res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.reject(new Error('simulated transport fault')).catch(rej);
        }
        return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
          Promise.resolve({ data: applyFilters(thenData), error: null }).then(res, rej);
      }
      if (prop === 'single' || prop === 'maybeSingle') {
        if (extra.throws || extra.throwsSingle) return () => Promise.reject(new Error('simulated transport fault'));
        return () =>
          Promise.resolve(
            extra.rowError ? { data: null, error: { message: extra.rowError } } : { data: rowData, error: null },
          );
      }
      if (prop === 'insert') {
        return (payload: unknown) => {
          extra.onInsert?.(payload);
          return self;
        };
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
      if (opts.enqueueEmpty) return { data: [], error: null };
      if (opts.enqueueSkipped) {
        return { data: [{ outbox_id: 'ob', channel: 'email', status: 'skipped', skip_reason: 'no_email_contact' }], error: null };
      }
      return { data: [{ outbox_id: 'ob', channel: 'email', status: 'pending', skip_reason: null }], error: null };
    }
    return { data: null, error: null };
  });
  const auditRows: Record<string, unknown>[] = [];
  const from = vi.fn((table: string) => {
    const throws = opts.throwOnTable === table;
    if (table === 'payment_audit_log') {
      return chain(null, null, { onInsert: (p) => auditRows.push(p as Record<string, unknown>) });
    }
    switch (table) {
      case 'bookings':
        // Awaited chains (finalizePriorityClaims + the staff .in() fetch) resolve
        // thenData; the email block ends in .single() (rowData: booking under test).
        return chain(opts.staffBookings ?? [], opts.booking, {
          rowError: opts.bookingContextError,
          throws,
          throwsSingle: opts.throwOnSingle === 'bookings',
        });
      case 'invoices':
        return chain(null, opts.invoiceFallbackRow ?? null);
      case 'academy_managers':
        return chain(opts.managers ?? [], null);
      case 'trainer_profiles':
        return chain(opts.trainerProfiles ?? [], { user_id: 'user-1' }, {
          throws,
          throwsSingle: opts.throwOnSingle === 'trainer_profiles',
        });
      case 'profiles':
        return chain(opts.profileRows ?? [], { full_name: 'Trainer T' });
      default:
        return chain(null, null);
    }
  });
  return { supabase: { functions: { invoke }, from, rpc }, invoke, rpc, auditRows };
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
    const p = staff[0][1] as { p_recipient_user_id: string; p_tenant_trainer_id: string | null; p_tenant_academy_profile_id: string | null; p_related_booking_ids: string[]; p_related_invoice_id: string | null; p_related_payment_id: string; p_payload: { subject: string; html: string } };
    expect(p.p_recipient_user_id).toBe('user-1');
    expect(p.p_tenant_trainer_id).toBe('tp-1');
    expect(p.p_tenant_academy_profile_id).toBeNull();
    expect(p.p_related_payment_id).toBe('tr_test'); // idempotency subject threaded through
    expect(p.p_related_booking_ids).toEqual(['B1', 'B2']);
    // PR 7: the invoice relation makes these staff rows visible on the INVOICE timeline
    expect(p.p_related_invoice_id).toBe('INV-1');
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

// ─────────────────────────────────────────────────────────────────────────────
// PR 10a — the 2026-07-20 regression.
//
// A real paid guest booking (tr_NSYo…) was transitioned by mollie-webhook, its invoice was
// created and mailed to the bookkeeper — and then the paying guest AND every staff recipient
// got nothing. No outbox row, no send, no alert. The whole notification half of the side
// effects sat inside ONE try whose catch only logged, and the staff fan-out additionally
// hung off `if (booking)` — a display-name fetch. So a single fault anywhere silently took
// out three independent notifications and left no trace to find it by.
//
// These pin the boundaries: each lane fails alone, and a failure is always LOUD.
// ─────────────────────────────────────────────────────────────────────────────
describe('PR 10a — one failing lane must not silence the others', () => {
  const staffFixture = {
    staffBookings: [{ id: 'B1', availability_slots: { ...SLOT, academy_profile_id: null, trainer_id: 'tp-1' } }],
    trainerProfiles: [{ id: 'tp-1', user_id: 'user-trainer' }],
    profileRows: [{ user_id: 'user-trainer', full_name: 'Trainer T' }],
  };

  const staffEnqueues = (rpc: { mock: { calls: [string, Record<string, unknown>?][] } }) =>
    rpc.mock.calls.filter((c) => c[0] === 'enqueue_notification'
      && (c[1] as { p_event_key?: string } | undefined)?.p_event_key === 'booking_confirmed_staff');

  it('still notifies STAFF when the booking-context read returns an ERROR', async () => {
    // The exact shape that produced zero staff rows: `const { data: booking }` discarded the
    // error, `if (booking)` then read false, and the fan-out vanished without a word.
    const { supabase, rpc } = makeFakeSupabase({
      booking: guestBooking,
      bookingContextError: 'column bookings.guest_players does not exist',
      invoiceInvokeData: { success: true, invoiceId: 'INV-1' },
      ...staffFixture,
    });
    await run(supabase);
    expect(staffEnqueues(rpc).length, 'staff must be notified even with no display name').toBeGreaterThan(0);
  });

  it('still notifies STAFF when the display-name lookup THROWS', async () => {
    const { supabase, rpc } = makeFakeSupabase({
      booking: guestBooking,
      throwOnSingle: 'bookings',
      invoiceInvokeData: { success: true, invoiceId: 'INV-1' },
      ...staffFixture,
    });
    await run(supabase);
    expect(staffEnqueues(rpc).length, 'a name lookup fault must not cancel notifications').toBeGreaterThan(0);
  });

  it('records a durable audit row with the COUNTS, so "zero" is visible in the database', async () => {
    // The original incident was only findable because notification_outbox was empty; there
    // was nothing in the payment trail saying the notifications had produced nothing.
    const { supabase, auditRows } = makeFakeSupabase({
      booking: guestBooking,
      invoiceInvokeData: { success: true, invoiceId: 'INV-1' },
      ...staffFixture,
    });
    await run(supabase);
    const row = auditRows.find((r) => r.status === 'booking_paid_notifications');
    expect(row, 'every paid booking must leave a notification-outcome row').toBeTruthy();
    expect(row!.metadata).toMatchObject({ staffRows: expect.any(Number), playerRows: expect.any(Number) });
    expect(row!.mollie_payment_id).toBe('tr_test');
  });

  it('runs the STAFF lane even when the PLAYER confirmation cannot enqueue, and alerts', async () => {
    // The lanes are independent notifications to different people. Before PR 10a they shared
    // one try/catch, so the payer's confirmation failing could take the staff with it.
    //
    // (The outer try/catch now wrapping the staff call is deliberate defence-in-depth, but it
    // is NOT asserted here: sendStaffBookingNotifications already wraps its own body, so the
    // outer catch is currently unreachable. A test for it passed even with the alert deleted —
    // it was catching the INNER alert — so it has been removed rather than left to look like
    // coverage it never provided.)
    const { supabase, rpc } = makeFakeSupabase({
      booking: guestBooking,
      invoiceInvokeData: { success: true, invoiceId: 'INV-1' },
      enqueueError: 'resolver unavailable',
      ...staffFixture,
    });
    const notify = await run(supabase);
    expect(staffEnqueues(rpc).length, 'the staff lane must still be attempted').toBeGreaterThan(0);
    expect(notify.mock.calls.length, 'an enqueue failure must alert, not vanish').toBeGreaterThan(0);
  });

  const auditOf = (auditRows: Record<string, unknown>[]) =>
    auditRows.find((r) => r.status === 'booking_paid_notifications')!.metadata as Record<string, number | string>;

  it('does NOT claim a row when the resolver answers [] with no error', async () => {
    // The owner's catch. `[]` + no error is the idempotent no-op: correct behaviour, but NO
    // row was produced by this run. Counting attempts would report a healthy notification for
    // precisely the situation this audit exists to expose.
    const { supabase, auditRows } = makeFakeSupabase({
      booking: guestBooking,
      invoiceInvokeData: { success: true, invoiceId: 'INV-1' },
      enqueueEmpty: true,
      ...staffFixture,
    });
    await run(supabase);
    const m = auditOf(auditRows);
    expect(m.staffRows, 'an empty resolver answer is not a staff row').toBe(0);
    expect(m.playerRows, 'an empty resolver answer is not a player row').toBe(0);
    expect(Number(m.staffNoop) + Number(m.playerNoop), 'but it IS recorded as a no-op').toBeGreaterThan(0);
  });

  it('counts a SKIPPED row as skipped, never as delivered', async () => {
    // A skipped row exists in the outbox but is a required notification that could not be
    // delivered — the worker alerts on it. It must never inflate the delivered count.
    const { supabase, auditRows } = makeFakeSupabase({
      booking: guestBooking,
      invoiceInvokeData: { success: true, invoiceId: 'INV-1' },
      enqueueSkipped: true,
      ...staffFixture,
    });
    await run(supabase);
    const m = auditOf(auditRows);
    expect(m.staffRows, 'a skipped row is not a delivered row').toBe(0);
    expect(Number(m.staffSkipped) + Number(m.skippedRows), 'it must be visible as skipped').toBeGreaterThan(0);
  });

  it('records the player OUTCOME, not merely that the call returned ok', async () => {
    const { supabase, auditRows } = makeFakeSupabase({
      booking: guestBooking,
      invoiceInvokeData: { success: true, invoiceId: 'INV-1' },
      ...staffFixture,
    });
    await run(supabase);
    expect(auditOf(auditRows).playerStatus).toBeTypeOf('string');
  });

  // The tests above exercise the STAFF lane's counting. The PLAYER lane short-circuits to
  // no_payer with the default fixture (its rows carry no payer identity), so give it a real
  // registered payer — otherwise playerRows is vacuously 0 and proves nothing.
  const payerFixture = {
    staffBookings: [{
      id: 'B1',
      player_id: 'P1',
      guest_player_id: null,
      profiles: { user_id: 'U1', full_name: 'Player P', email: 'p@example.com', preferred_language: 'nl' },
      guest_players: null,
      availability_slots: { ...SLOT, academy_profile_id: null, trainer_id: 'tp-1' },
    }],
    trainerProfiles: [{ id: 'tp-1', user_id: 'user-trainer' }],
    profileRows: [{ user_id: 'user-trainer', full_name: 'Trainer T' }],
  };

  it('does NOT count an idempotent PLAYER no-op as a produced row', async () => {
    // enqueue_notification answering [] means the idempotency key already existed — a
    // duplicate webhook/verify delivery. ok=true, but this run produced no row.
    const { supabase, auditRows } = makeFakeSupabase({
      booking: playerBooking,
      invoiceInvokeData: { success: true, invoiceId: 'INV-1' },
      enqueueEmpty: true,
      ...payerFixture,
    });
    await run(supabase);
    const m = auditOf(auditRows);
    expect(m.playerRows, 'a no-op produced no player row').toBe(0);
    expect(m.playerNoop, 'but it must be recorded as a no-op').toBeGreaterThan(0);
    expect(m.playerStatus).toBe('already_enqueued');
  });

  it('counts a real PLAYER enqueue as exactly one row', async () => {
    const { supabase, auditRows } = makeFakeSupabase({
      booking: playerBooking,
      invoiceInvokeData: { success: true, invoiceId: 'INV-1' },
      ...payerFixture,
    });
    await run(supabase);
    const m = auditOf(auditRows);
    expect(m.playerRows).toBe(1);
    expect(m.playerStatus).toBe('pending');
  });
});

