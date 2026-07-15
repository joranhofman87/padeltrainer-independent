// Public "open for registration" listings after the decouple: getActiveCycles reads the
// STANDALONE registrations table (anon RLS: status='open' only) with a column-scoped select —
// settings reduced to the single payment_methods key — and maps rows onto the Cycle shape the
// open-cycles cards consume. hasPlayerApplied keys on registration_id.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const order = vi.fn();
const maybeSingle = vi.fn();
const calls: { table: string; select: string; filters: Record<string, unknown> }[] = [];

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: (table: string) => {
      const call = { table, select: '', filters: {} as Record<string, unknown> };
      calls.push(call);
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: (cols: string) => { call.select = cols; return chain; },
        eq: (k: string, v: unknown) => { call.filters[k] = v; return chain; },
        in: (k: string, v: unknown) => { call.filters[k] = v; return chain; },
        order: (...a: unknown[]) => order(...a),
        maybeSingle: () => maybeSingle(),
      });
      return chain;
    },
  },
}));
vi.mock('@/lib/deployDrift', () => ({
  isMissingRpc: () => false,
  isMissingRelation: () => false,
  reportDeployDriftFallback: vi.fn(),
}));

import { getActiveCycles, hasPlayerApplied, isRegistrationOpenForSignup } from '@/lib/cycles';

describe('getActiveCycles (public open-registrations list)', () => {
  beforeEach(() => {
    calls.length = 0;
    vi.clearAllMocks();
  });

  it('reads open registrations for the owner and maps them onto the Cycle shape', async () => {
    order.mockResolvedValueOnce({
      data: [{
        id: 'r1', owner_type: 'academy', owner_id: 'a1', format: 'registration',
        name: 'Najaar', description: 'd', start_date: '2026-08-24', end_date: '2026-12-04',
        enrollment_deadline: null, status: 'open', total_price: null,
        currency: 'EUR', price_table: [{ label: 'Duo', price: 38 }], location_id: 'loc1',
        created_at: '2026-07-13', updated_at: '2026-07-14', payment_methods: 'online',
      }],
      error: null,
    });

    const rows = await getActiveCycles('academy', 'a1');

    const listCall = calls.find((c) => c.table === 'registrations')!;
    expect(listCall).toBeTruthy();
    expect(listCall.filters).toMatchObject({ owner_type: 'academy', owner_id: 'a1', status: 'open' });
    // Column-scoped: full settings never selected; only the payment_methods key.
    expect(listCall.select).toContain('payment_methods:settings->payment_methods');
    expect(listCall.select).not.toMatch(/(^|,)\s*settings\s*(,|$)/);

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('r1'); // the registration's own id → /register/:id links resolve
    expect(rows[0].type).toBe('registration'); // format → type
    expect((rows[0].settings as Record<string, unknown>).payment_methods).toBe('online');
  });

  it('propagates a query error', async () => {
    order.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    await expect(getActiveCycles('trainer', 't1')).rejects.toBeTruthy();
  });
});

describe('isRegistrationOpenForSignup (deadline gate)', () => {
  const soon = new Date(Date.now() + 30 * 864e5).toISOString();
  const past = new Date(Date.now() - 30 * 864e5).toISOString();

  it('open with a FUTURE deadline → shown', () => {
    expect(isRegistrationOpenForSignup({ enrollment_deadline: soon, is_always_open: false })).toBe(true);
  });
  it('PAST deadline → hidden', () => {
    expect(isRegistrationOpenForSignup({ enrollment_deadline: past, is_always_open: false })).toBe(false);
  });
  it('NO deadline → shown', () => {
    expect(isRegistrationOpenForSignup({ enrollment_deadline: null, is_always_open: false })).toBe(true);
  });
  it('always-open ignores a past deadline → shown', () => {
    expect(isRegistrationOpenForSignup({ enrollment_deadline: past, is_always_open: true })).toBe(true);
  });
});

describe('getActiveCycles hides past-deadline forms', () => {
  beforeEach(() => { calls.length = 0; vi.clearAllMocks(); });

  it('drops forms whose enrollment deadline has passed, keeps future/no-deadline', async () => {
    const soon = new Date(Date.now() + 30 * 864e5).toISOString();
    const past = new Date(Date.now() - 30 * 864e5).toISOString();
    const mkRow = (id: string, enrollment_deadline: string | null) => ({
      id, owner_type: 'academy', owner_id: 'a1', format: 'registration', name: id,
      description: null, start_date: '2026-08-24', end_date: '2026-12-04', enrollment_deadline,
      status: 'open', total_price: null, currency: 'EUR', price_table: null, location_id: null,
      created_at: '2026-07-13', updated_at: '2026-07-14', payment_methods: null,
    });
    order.mockResolvedValueOnce({
      data: [mkRow('future', soon), mkRow('past', past), mkRow('nodeadline', null)],
      error: null,
    });

    const rows = await getActiveCycles('academy', 'a1');
    expect(rows.map((r) => r.id).sort()).toEqual(['future', 'nodeadline']);
  });
});

describe('hasPlayerApplied', () => {
  beforeEach(() => {
    calls.length = 0;
    vi.clearAllMocks();
  });

  it('checks intake_requests by registration_id (the canonical form link)', async () => {
    maybeSingle.mockResolvedValueOnce({ data: { id: 'i1' }, error: null });
    const applied = await hasPlayerApplied('r1', 'p1');
    expect(applied).toBe(true);
    const call = calls.find((c) => c.table === 'intake_requests')!;
    expect(call.filters).toMatchObject({ registration_id: 'r1', player_id: 'p1' });
    expect('cycle_id' in call.filters).toBe(false);
  });
});
