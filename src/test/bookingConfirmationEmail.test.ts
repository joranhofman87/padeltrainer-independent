// @vitest-environment node
// sendPlayerBookingConfirmation — the unified player payment-confirmation, now ENQUEUED
// onto the notification outbox (PR 6a) rather than sent directly via Resend. It COMPOSES
// "what you booked" (all sessions) + the invoice PDF (best-effort, in the outbox payload) +
// a sign-in link, for BOTH a guest (signup link, email prefilled; a tenant-scoped contact
// upserted first) and a registered player (login link; persons.email account fallback),
// single-slot or cyclus. Drives the REAL helper with a mocked Deno env + fetch + a fake
// supabase whose rpc() records the enqueue / ensure_guest_email_contact calls (no module mocks).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendPlayerBookingConfirmation } from '../../supabase/functions/_shared/booking-confirmation-email.ts';

const ENV: Record<string, string> = {
  SUPABASE_URL: 'https://sb.test',
  SUPABASE_SERVICE_ROLE_KEY: 'svc_key',
  PUBLIC_APP_URL: 'https://app.padeltrainer.test',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fetchMock: any;

function installEnv(overrides: Record<string, string | undefined> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).Deno = { env: { get: (k: string) => (k in overrides ? overrides[k] : ENV[k]) } };
}

beforeEach(() => {
  installEnv();

  fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes('/functions/v1/generate-invoice')) {
      return { ok: true, json: async () => ({ pdfUrl: 'https://sb.test/pdf/x.pdf' }) };
    }
    if (String(url).includes('/pdf/')) {
      return { ok: true, arrayBuffer: async () => new Uint8Array([37, 80, 68, 70]).buffer }; // %PDF
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = fetchMock;
});

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).Deno;
  vi.restoreAllMocks();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeSupabase(opts: { bookings: any[]; identityEmail?: string | null; invoiceNumber?: string | null; enqueueRows?: any[]; contactError?: string }) {
  const rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain = (data: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const self: any = new Proxy(() => {}, {
      get(_t, p) {
        if (p === 'then') return (res: (v: unknown) => unknown) => Promise.resolve({ data, error: null }).then(res);
        if (p === 'single' || p === 'maybeSingle') {
          return () => Promise.resolve({ data: Array.isArray(data) ? data[0] ?? null : data, error: null });
        }
        return () => self;
      },
    });
    return self;
  };
  const supabase = {
    from: (table: string) => {
      if (table === 'bookings') return chain(opts.bookings);
      if (table === 'invoices') return chain({ id: 'INV-FB', invoice_number: opts.invoiceNumber ?? 'F-2026-001' });
      return chain(null);
    },
    rpc: async (name: string, params: Record<string, unknown>) => {
      rpcCalls.push({ name, params });
      if (name === 'get_invoice_recipient_identity') {
        return { data: opts.identityEmail !== undefined ? [{ email: opts.identityEmail }] : [], error: null };
      }
      if (name === 'ensure_guest_email_contact') {
        return opts.contactError ? { data: null, error: { message: opts.contactError } } : { data: 'contact-1', error: null };
      }
      if (name === 'enqueue_notification') {
        return { data: opts.enqueueRows ?? [{ outbox_id: 'ob1', channel: 'email', status: 'pending', skip_reason: null }], error: null };
      }
      return { data: null, error: null };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { supabase, rpcCalls };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const enqueueCall = (rpcCalls: Array<{ name: string; params: any }>) => rpcCalls.find((c) => c.name === 'enqueue_notification')?.params;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const contactCall = (rpcCalls: Array<{ name: string; params: any }>) => rpcCalls.find((c) => c.name === 'ensure_guest_email_contact')?.params;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SLOT = (over: any = {}) => ({
  start_time: '2027-03-02T09:00:00Z',
  end_time: '2027-03-02T10:00:00Z',
  cyclus_name: 'Cyclus ma 10:00',
  trainer_id: 'TR-1',
  academy_profile_id: 'AC-1',
  locations: { name: 'Hal 1' },
  ...over,
});
const logStep = () => {};

describe('sendPlayerBookingConfirmation', () => {
  it('registered player: enqueues to the account (user_id) with ALL sessions, a PDF payload, and a LOGIN link', async () => {
    const { supabase, rpcCalls } = makeSupabase({
      bookings: [
        { id: 'B1', player_id: 'P1', guest_player_id: null, availability_slots: SLOT(), profiles: { user_id: 'U1', full_name: 'Player P', email: 'p@example.com', preferred_language: 'nl' }, guest_players: null },
        { id: 'B2', player_id: 'P1', guest_player_id: null, availability_slots: SLOT({ start_time: '2027-03-09T09:00:00Z', end_time: '2027-03-09T10:00:00Z' }), profiles: { user_id: 'U1', full_name: 'Player P', email: 'p@example.com', preferred_language: 'nl' }, guest_players: null },
      ],
    });
    const res = await sendPlayerBookingConfirmation({ supabase, bookingIds: ['B1', 'B2'], invoiceId: 'INV-1', molliePaymentId: 'tr_123', logStep });
    expect(res).toMatchObject({ ok: true, isGuest: false, pdfAttached: true, status: 'pending' });
    // registered → account fallback, no guest contact upsert
    expect(contactCall(rpcCalls)).toBeUndefined();
    const enq = enqueueCall(rpcCalls);
    expect(enq.p_event_key).toBe('booking_confirmed_player');
    expect(enq.p_recipient_user_id).toBe('U1');
    expect(enq.p_recipient_guest_player_id).toBeNull();
    expect(enq.p_tenant_academy_profile_id).toBe('AC-1');
    expect(enq.p_tenant_trainer_id).toBe('TR-1');
    expect(enq.p_related_payment_id).toBe('tr_123');
    expect(enq.p_payload.subject).toContain('Bevestiging');
    expect(enq.p_payload.html).toContain('Bekijk mijn sessies');
    expect(enq.p_payload.html).toContain('/app/auth?redirect=');
    expect(enq.p_payload.html).not.toContain('/app/signup'); // registered → login, not signup
    expect((enq.p_payload.html.match(/Hal 1/g) || []).length).toBe(2); // both sessions rendered
    expect(enq.p_payload.attachments).toHaveLength(1);
    expect(enq.p_payload.attachments[0].filename).toBe('F-2026-001.pdf');
  });

  it('guest: upserts a tenant-scoped contact then enqueues to the guest with a SIGNUP link + auto-link hint', async () => {
    const { supabase, rpcCalls } = makeSupabase({
      bookings: [{ id: 'B1', player_id: null, guest_player_id: 'G1', availability_slots: SLOT(), profiles: null, guest_players: { full_name: 'Kim de Kort', email: 'kim@example.com' } }],
      identityEmail: 'kim@example.com',
    });
    const res = await sendPlayerBookingConfirmation({ supabase, bookingIds: ['B1'], invoiceId: 'INV-1', molliePaymentId: 'tr_g', logStep });
    expect(res).toMatchObject({ ok: true, isGuest: true, pdfAttached: true });
    const contact = contactCall(rpcCalls);
    expect(contact.p_guest_player_id).toBe('G1');
    expect(contact.p_email).toBe('kim@example.com');
    expect(contact.p_academy_profile_id).toBe('AC-1');
    expect(contact.p_trainer_id).toBe('TR-1');
    const enq = enqueueCall(rpcCalls);
    expect(enq.p_recipient_guest_player_id).toBe('G1');
    expect(enq.p_recipient_user_id).toBeNull();
    expect(enq.p_payload.html).toContain('/app/signup/player?email=kim%40example.com');
    expect(enq.p_payload.html).toContain('Account aanmaken');
    expect(enq.p_payload.html).toContain('zelfde e-mailadres'); // the "use the same email → auto-link" hint
  });

  it('guest with no RPC email: falls back to the joined guest_players.email for the contact upsert', async () => {
    const { supabase, rpcCalls } = makeSupabase({
      bookings: [{ id: 'B1', player_id: null, guest_player_id: 'G1', availability_slots: SLOT(), profiles: null, guest_players: { full_name: 'Guest', email: 'fallback@example.com' } }],
      identityEmail: null,
    });
    const res = await sendPlayerBookingConfirmation({ supabase, bookingIds: ['B1'], invoiceId: null, logStep });
    expect(res.ok).toBe(true);
    expect(contactCall(rpcCalls).p_email).toBe('fallback@example.com');
  });

  it('guest contact upsert RPC returns an error → fails LOUDLY (enqueue_failed), does NOT enqueue a misleading skipped', async () => {
    const { supabase, rpcCalls } = makeSupabase({
      bookings: [{ id: 'B1', player_id: null, guest_player_id: 'G1', availability_slots: SLOT(), profiles: null, guest_players: { full_name: 'Guest', email: 'g@example.com' } }],
      identityEmail: 'g@example.com',
      contactError: 'coherence CHECK violated',
    });
    const res = await sendPlayerBookingConfirmation({ supabase, bookingIds: ['B1'], invoiceId: null, logStep });
    expect(res).toMatchObject({ ok: false, reason: 'enqueue_failed', isGuest: true });
    expect(res.detail).toContain('coherence CHECK');
    expect(enqueueCall(rpcCalls)).toBeUndefined(); // never enqueued → no misleading no_email_contact row
  });

  it('still enqueues (no attachment) when PDF generation fails', async () => {

    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/functions/v1/generate-invoice')) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const { supabase, rpcCalls } = makeSupabase({ bookings: [{ id: 'B1', player_id: 'P1', guest_player_id: null, availability_slots: SLOT(), profiles: { user_id: 'U1', full_name: 'P', email: 'p@example.com', preferred_language: 'nl' }, guest_players: null }] });
    const res = await sendPlayerBookingConfirmation({ supabase, bookingIds: ['B1'], invoiceId: 'INV-1', logStep });
    expect(res).toMatchObject({ ok: true, pdfAttached: false });
    expect(enqueueCall(rpcCalls).p_payload.attachments).toBeUndefined();
  });

  it('required-but-undeliverable enqueue (skipped) → ok:false, reason skipped, skipReason surfaced', async () => {
    const { supabase } = makeSupabase({
      bookings: [{ id: 'B1', player_id: null, guest_player_id: 'G1', availability_slots: SLOT(), profiles: null, guest_players: { full_name: 'Guest', email: null } }],
      identityEmail: null,
      enqueueRows: [{ outbox_id: 'ob-skip', channel: 'email', status: 'skipped', skip_reason: 'no_email_contact' }],
    });
    const res = await sendPlayerBookingConfirmation({ supabase, bookingIds: ['B1'], invoiceId: null, logStep });
    expect(res).toMatchObject({ ok: false, reason: 'skipped', status: 'skipped', skipReason: 'no_email_contact' });
  });

  it('idempotent re-enqueue (resolver returns no new rows) → ok:true, status already_enqueued', async () => {
    const { supabase } = makeSupabase({
      bookings: [{ id: 'B1', player_id: 'P1', guest_player_id: null, availability_slots: SLOT(), profiles: { user_id: 'U1', full_name: 'P', email: 'p@example.com', preferred_language: 'nl' }, guest_players: null }],
      enqueueRows: [],
    });
    const res = await sendPlayerBookingConfirmation({ supabase, bookingIds: ['B1'], invoiceId: 'INV-1', logStep });
    expect(res).toMatchObject({ ok: true, status: 'already_enqueued' });
  });

  it('no payer (empty bookings) → no enqueue, reason no_payer', async () => {
    const { supabase, rpcCalls } = makeSupabase({ bookings: [] });
    const res = await sendPlayerBookingConfirmation({ supabase, bookingIds: ['B1'], invoiceId: null, logStep });
    expect(res).toEqual({ ok: false, reason: 'no_payer' });
    expect(enqueueCall(rpcCalls)).toBeUndefined();
  });

  it('English preference: renders the English CTA in the enqueued payload', async () => {
    const { supabase, rpcCalls } = makeSupabase({
      bookings: [{ id: 'B1', player_id: 'P1', guest_player_id: null, availability_slots: SLOT(), profiles: { user_id: 'U1', full_name: 'Player P', email: 'p@example.com', preferred_language: 'en' }, guest_players: null }],
    });
    await sendPlayerBookingConfirmation({ supabase, bookingIds: ['B1'], invoiceId: 'INV-1', logStep });
    expect(enqueueCall(rpcCalls).p_payload.html).toContain('View my sessions');
  });
});
