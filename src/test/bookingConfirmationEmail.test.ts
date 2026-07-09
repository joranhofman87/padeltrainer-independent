// @vitest-environment node
// sendPlayerBookingConfirmation — the unified player payment-confirmation email:
// "what you booked" (all sessions) + the invoice PDF (best-effort) + a sign-in link,
// for BOTH a guest (signup link, email prefilled) and a registered player (login link),
// single-slot or cyclus. Drives the REAL helper with a mocked Deno env + fetch + a fake
// supabase (no module mocks).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendPlayerBookingConfirmation } from '../../supabase/functions/_shared/booking-confirmation-email.ts';

const ENV: Record<string, string> = {
  RESEND_API_KEY: 're_test',
  SUPABASE_URL: 'https://sb.test',
  SUPABASE_SERVICE_ROLE_KEY: 'svc_key',
  PUBLIC_APP_URL: 'https://app.padeltrainer.test',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let resendPayloads: any[];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fetchMock: any;

function installEnv(overrides: Record<string, string | undefined> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).Deno = { env: { get: (k: string) => (k in overrides ? overrides[k] : ENV[k]) } };
}

beforeEach(() => {
  resendPayloads = [];
  installEnv();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fetchMock = vi.fn(async (url: string, init?: any) => {
    if (String(url).includes('api.resend.com/emails')) {
      resendPayloads.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ id: 'em_1' }) };
    }
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
function makeSupabase(opts: { bookings: any[]; identityEmail?: string | null; invoiceNumber?: string | null }) {
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
  return {
    from: (table: string) => {
      if (table === 'bookings') return chain(opts.bookings);
      if (table === 'invoices') return chain({ id: 'INV-FB', invoice_number: opts.invoiceNumber ?? 'F-2026-001' });
      return chain(null);
    },
    rpc: async () => ({ data: opts.identityEmail !== undefined ? [{ email: opts.identityEmail }] : [], error: null }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SLOT = (over: any = {}) => ({
  start_time: '2027-03-02T09:00:00Z',
  end_time: '2027-03-02T10:00:00Z',
  cyclus_name: 'Cyclus ma 10:00',
  academy_profile_id: 'AC-1',
  locations: { name: 'Hal 1' },
  ...over,
});
const logStep = () => {};

describe('sendPlayerBookingConfirmation', () => {
  it('registered player: sends to the profile email with ALL sessions, a PDF, and a LOGIN link', async () => {
    const supabase = makeSupabase({
      bookings: [
        { id: 'B1', player_id: 'P1', guest_player_id: null, availability_slots: SLOT(), profiles: { full_name: 'Player P', email: 'p@example.com', preferred_language: 'nl' }, guest_players: null },
        { id: 'B2', player_id: 'P1', guest_player_id: null, availability_slots: SLOT({ start_time: '2027-03-09T09:00:00Z', end_time: '2027-03-09T10:00:00Z' }), profiles: { full_name: 'Player P', email: 'p@example.com', preferred_language: 'nl' }, guest_players: null },
      ],
    });
    const res = await sendPlayerBookingConfirmation({ supabase, bookingIds: ['B1', 'B2'], invoiceId: 'INV-1', logStep });
    expect(res).toMatchObject({ ok: true, isGuest: false, pdfAttached: true });
    expect(resendPayloads).toHaveLength(1);
    const p = resendPayloads[0];
    expect(p.to).toEqual(['p@example.com']);
    expect(p.html).toContain('Bekijk mijn sessies');
    expect(p.html).toContain('/app/auth?redirect=');
    expect(p.html).not.toContain('/app/signup'); // registered → login, not signup
    expect((p.html.match(/Hal 1/g) || []).length).toBe(2); // both sessions rendered
    expect(p.attachments).toHaveLength(1);
    expect(p.attachments[0].filename).toBe('F-2026-001.pdf');
  });

  it('guest: sends to the resolved guest email with a SIGNUP link (email prefilled) + auto-link hint', async () => {
    const supabase = makeSupabase({
      bookings: [{ id: 'B1', player_id: null, guest_player_id: 'G1', availability_slots: SLOT(), profiles: null, guest_players: { full_name: 'Kim de Kort', email: 'kim@example.com' } }],
      identityEmail: 'kim@example.com',
    });
    const res = await sendPlayerBookingConfirmation({ supabase, bookingIds: ['B1'], invoiceId: 'INV-1', logStep });
    expect(res).toMatchObject({ ok: true, isGuest: true, pdfAttached: true });
    const p = resendPayloads[0];
    expect(p.to).toEqual(['kim@example.com']);
    expect(p.html).toContain('/app/signup/player?email=kim%40example.com');
    expect(p.html).toContain('Account aanmaken');
    expect(p.html).toContain('zelfde e-mailadres'); // the "use the same email → auto-link" hint
  });

  it('guest with no RPC email: falls back to the joined guest_players.email', async () => {
    const supabase = makeSupabase({
      bookings: [{ id: 'B1', player_id: null, guest_player_id: 'G1', availability_slots: SLOT(), profiles: null, guest_players: { full_name: 'Guest', email: 'fallback@example.com' } }],
      identityEmail: null,
    });
    const res = await sendPlayerBookingConfirmation({ supabase, bookingIds: ['B1'], invoiceId: null, logStep });
    expect(res.ok).toBe(true);
    expect(resendPayloads[0].to).toEqual(['fallback@example.com']);
  });

  it('still sends (no attachment) when PDF generation fails', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fetchMock.mockImplementation(async (url: string, init?: any) => {
      if (String(url).includes('api.resend.com/emails')) { resendPayloads.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ id: 'em' }) }; }
      if (String(url).includes('/functions/v1/generate-invoice')) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const supabase = makeSupabase({ bookings: [{ id: 'B1', player_id: 'P1', guest_player_id: null, availability_slots: SLOT(), profiles: { full_name: 'P', email: 'p@example.com', preferred_language: 'nl' }, guest_players: null }] });
    const res = await sendPlayerBookingConfirmation({ supabase, bookingIds: ['B1'], invoiceId: 'INV-1', logStep });
    expect(res).toMatchObject({ ok: true, pdfAttached: false });
    expect(resendPayloads[0].attachments).toBeUndefined();
  });

  it('no RESEND_API_KEY → no-op (reason no_resend, no fetch)', async () => {
    installEnv({ RESEND_API_KEY: undefined });
    const supabase = makeSupabase({ bookings: [{ id: 'B1', player_id: 'P1', guest_player_id: null, availability_slots: SLOT(), profiles: { full_name: 'P', email: 'p@example.com', preferred_language: 'nl' }, guest_players: null }] });
    const res = await sendPlayerBookingConfirmation({ supabase, bookingIds: ['B1'], invoiceId: 'INV-1', logStep });
    expect(res).toEqual({ ok: false, reason: 'no_resend' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no payer (empty bookings) → no email, reason no_payer', async () => {
    const supabase = makeSupabase({ bookings: [] });
    const res = await sendPlayerBookingConfirmation({ supabase, bookingIds: ['B1'], invoiceId: null, logStep });
    expect(res).toEqual({ ok: false, reason: 'no_payer' });
    expect(resendPayloads).toHaveLength(0);
  });

  it('English preference: renders the English CTA', async () => {
    const supabase = makeSupabase({
      bookings: [{ id: 'B1', player_id: 'P1', guest_player_id: null, availability_slots: SLOT(), profiles: { full_name: 'Player P', email: 'p@example.com', preferred_language: 'en' }, guest_players: null }],
    });
    await sendPlayerBookingConfirmation({ supabase, bookingIds: ['B1'], invoiceId: 'INV-1', logStep });
    expect(resendPayloads[0].html).toContain('View my sessions');
  });
});
