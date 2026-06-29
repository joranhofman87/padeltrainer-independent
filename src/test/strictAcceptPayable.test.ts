import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression guard for the strict-accept CRITICAL (money-path review): a STRICT accept creates the
 * booking as a HOLD (status='payment_pending'), and acceptClaimAndStartPayment must treat that hold
 * as PAYABLE — keep it in the "still-payable" set and proceed to the Mollie checkout — NOT drop it
 * and release the seat. The bug was a hardcoded status list `['pending','confirmed']` that excluded
 * 'payment_pending', so every strict accept returned 'strict_mollie_unavailable'.
 */

// Hoisted so the vi.mock factory can reference it (vi.mock is lifted above imports).
const h = vi.hoisted(() => {
  const state: { bookingRows: Record<string, unknown>[]; invokeArgs: { fn: string; body: unknown }[] } = {
    bookingRows: [],
    invokeArgs: [],
  };
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
    if (fn === 'create-mollie-payment') return Promise.resolve({ data: { checkoutUrl: 'https://mollie.test/checkout/h1' }, error: null });
    return Promise.resolve({ data: null, error: null });
  });
  const supabase = {
    auth: { getUser: vi.fn(() => Promise.resolve({ data: { user: { id: 'u1' } } })) },
    rpc,
    functions: { invoke },
    from: (table: string) => {
      if (table === 'cycles') return builder(() => [{ id: 'cy1', settings: { rebook_payment_mode: 'upfront', rebook_strict_mollie: true } }]);
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
vi.mock('@/lib/deployDrift', () => ({ reportDeployDriftFallback: vi.fn() }));

import { acceptClaimAndStartPayment } from '@/lib/priorityClaims';

beforeEach(() => {
  h.state.invokeArgs = [];
  h.rpc.mockClear();
  h.invoke.mockClear();
});

describe('acceptClaimAndStartPayment — strict hold is payable (money-path regression)', () => {
  it('a payment_pending HOLD proceeds to the Mollie checkout (not released)', async () => {
    h.state.bookingRows = [{ id: 'h1', slot_id: 's1', status: 'payment_pending', payment_status: 'pending', player_id: 'p1' }];

    const res = await acceptClaimAndStartPayment('tok-1');

    expect(res?.mode).toBe('upfront');
    expect(res?.checkoutUrl).toBe('https://mollie.test/checkout/h1');
    const mollieCall = h.state.invokeArgs.find((c) => c.fn === 'create-mollie-payment');
    expect(mollieCall).toBeTruthy();
    expect((mollieCall!.body as { bookingIds: string[] }).bookingIds).toEqual(['h1']);
    expect(h.rpc).not.toHaveBeenCalledWith('release_rebook_hold', expect.anything());
  });

  it('with NO payable booking, strict releases + returns strict_mollie_unavailable', async () => {
    h.state.bookingRows = [{ id: 'h1', slot_id: 's1', status: 'cancelled', payment_status: 'pending', player_id: 'p1' }];

    const res = await acceptClaimAndStartPayment('tok-1');

    expect(res?.mode).toBe('strict_mollie_unavailable');
    expect(h.state.invokeArgs.find((c) => c.fn === 'create-mollie-payment')).toBeFalsy();
  });
});
