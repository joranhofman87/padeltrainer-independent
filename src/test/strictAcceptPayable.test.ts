import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Slice A changed the UPFRONT rebook flow: acceptClaimAndStartPayment now delegates the whole
 * accept + full-price mint + checkout to the no-login token path (create-rebook-invoice-public) and
 * MAPS its result — logged-in or logged-out. This guards that mapping, and (for the legacy authed
 * fallback reached only when the public fn returns 'is_group') preserves the original strict-hold-
 * is-payable money-path regression: a STRICT accept's payment_pending HOLD must proceed to checkout,
 * not be released.
 */

// Hoisted so the vi.mock factory can reference it (vi.mock is lifted above imports).
const h = vi.hoisted(() => {
  const state: {
    bookingRows: Record<string, unknown>[];
    invokeArgs: { fn: string; body: unknown }[];
    publicResult: Record<string, unknown> | null;
  } = { bookingRows: [], invokeArgs: [], publicResult: null };
  function builder(getRows: () => Record<string, unknown>[]) {
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    const rows = () => getRows().filter((r) => filters.every((f) => f(r)));
    const api: Record<string, unknown> = {
      select: () => api,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return api; },
      in: (c: string, vals: unknown[]) => { const s = new Set(vals); filters.push((r) => s.has(r[c])); return api; },
      maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (v: { data: Record<string, unknown>[]; error: null }) => unknown) =>
        Promise.resolve({ data: rows(), error: null }).then(resolve),
    };
    return api;
  }
  const rpc = vi.fn((name: string) => {
    if (name === 'respond_to_priority_claim') return Promise.resolve({ data: { ok: true, status: 'claimed', booking_id: 'h1', strict: true }, error: null });
    if (name === 'get_priority_claim_by_token') return Promise.resolve({ data: { claim: { player_id: 'p1' }, slot: { id: 's1', cyclus_id: 'cy1', cyclus_name: 'Maandag', trainer_id: 'tr1' } }, error: null });
    if (name === 'release_rebook_hold') return Promise.resolve({ data: { ok: true, released: true }, error: null });
    return Promise.resolve({ data: null, error: null });
  });
  const invoke = vi.fn((fn: string, opts: { body: unknown }) => {
    state.invokeArgs.push({ fn, body: opts.body });
    if (fn === 'create-rebook-invoice-public') return Promise.resolve({ data: state.publicResult, error: null });
    if (fn === 'create-mollie-payment') return Promise.resolve({ data: { checkoutUrl: 'https://mollie.test/checkout/h1' }, error: null });
    return Promise.resolve({ data: null, error: null });
  });
  const supabase = {
    auth: { getUser: vi.fn(() => Promise.resolve({ data: { user: { id: 'u1' } } })) },
    rpc,
    functions: { invoke },
    from: (table: string) => {
      // P2-1: priorityClaims reads cyclus settings through the sanitized cycles_public
      // view first (falling back to base cycles). The view exposes the same settings
      // (minus the private notify keys), so stub both relations identically.
      if (table === 'cycles' || table === 'cycles_public') return builder(() => [{ id: 'cy1', settings: { rebook_payment_mode: 'upfront', rebook_strict_mollie: true } }]);
      if (table === 'availability_slots') return builder(() => [{ id: 's1', price_per_session: 10, trainer_id: 'tr1' }]);
      if (table === 'slot_priority_claims') return builder(() => []);
      if (table === 'bookings') return builder(() => state.bookingRows);
      return builder(() => []);
    },
  };
  return { state, supabase, rpc, invoke };
});

vi.mock('@/lib/supabaseClient', () => ({ supabase: h.supabase }));
vi.mock('@/lib/academyTrainerPayments', () => ({ hasValidPaymentSetup: vi.fn(() => Promise.resolve({ valid: true })) }));
vi.mock('@/lib/deployDrift', () => ({ reportDeployDriftFallback: vi.fn(), isMissingRelation: vi.fn(() => false) }));

import { acceptClaimAndStartPayment } from '@/lib/priorityClaims';

beforeEach(() => {
  h.state.invokeArgs = [];
  h.state.bookingRows = [];
  h.state.publicResult = null;
  h.rpc.mockClear();
  h.invoke.mockClear();
});

describe('acceptClaimAndStartPayment — UPFRONT delegates to the no-login public path (Slice A)', () => {
  it('maps the public fn checkoutUrl → mode "upfront" (no login, no create-mollie-payment)', async () => {
    h.state.publicResult = { ok: true, checkoutUrl: 'https://mollie.test/pay/x', publicToken: 'tk-x' };
    const res = await acceptClaimAndStartPayment('tok-1');
    expect(res?.mode).toBe('upfront');
    expect(res?.checkoutUrl).toBe('https://mollie.test/pay/x');
    expect(h.state.invokeArgs.find((c) => c.fn === 'create-rebook-invoice-public')).toBeTruthy();
    // The legacy authed path (create-mollie-payment) is NOT used for the upfront delegate.
    expect(h.state.invokeArgs.find((c) => c.fn === 'create-mollie-payment')).toBeFalsy();
  });

  it('maps the public fn publicToken (no checkout) → mode "upfront_invoiced" → /pay/:token', async () => {
    h.state.publicResult = { ok: true, publicToken: 'tk-y' };
    const res = await acceptClaimAndStartPayment('tok-1');
    expect(res?.mode).toBe('upfront_invoiced');
    expect(res?.publicToken).toBe('tk-y');
  });

  it('maps strict_mollie_unavailable → same mode (seat released server-side)', async () => {
    h.state.publicResult = { ok: false, reason: 'strict_mollie_unavailable' };
    const res = await acceptClaimAndStartPayment('tok-1');
    expect(res?.mode).toBe('strict_mollie_unavailable');
    expect(h.state.invokeArgs.find((c) => c.fn === 'create-mollie-payment')).toBeFalsy();
  });

  it('a mint failure surfaces as "reserved" (upfront_unavailable), never a double-accept', async () => {
    h.state.publicResult = { ok: false, reason: 'business_incomplete' };
    const res = await acceptClaimAndStartPayment('tok-1');
    expect(res?.mode).toBe('upfront_unavailable');
  });

  it("a group member's just-my-spot (is_group) falls through to the legacy authed path; a strict HOLD stays payable → checkout", async () => {
    h.state.publicResult = { ok: false, reason: 'is_group' };
    h.state.bookingRows = [{ id: 'h1', slot_id: 's1', status: 'payment_pending', payment_status: 'pending', player_id: 'p1' }];
    const res = await acceptClaimAndStartPayment('tok-1');
    expect(res?.mode).toBe('upfront');
    const mollieCall = h.state.invokeArgs.find((c) => c.fn === 'create-mollie-payment');
    expect(mollieCall).toBeTruthy();
    expect((mollieCall!.body as { bookingIds: string[] }).bookingIds).toEqual(['h1']);
    expect(h.rpc).not.toHaveBeenCalledWith('release_rebook_hold', expect.anything());
  });
});
