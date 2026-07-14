import { describe, it, expect, vi, beforeEach } from 'vitest';

const maybeSingle = vi.fn();
const order = vi.fn();
const inFn = vi.fn();
const rpcFn = vi.fn();
const updateEq = vi.fn();
// Chainable builder: select/eq return the chain; maybeSingle/order/in are the terminal resolvers.
// update(...).eq(...) resolves via updateEq (used by syncRegistrationStatus, not exercised here).
const chain = {
  select: () => chain,
  eq: () => chain,
  update: () => ({ eq: (...a: unknown[]) => updateEq(...a) }),
  order: (...a: unknown[]) => order(...a),
  in: (...a: unknown[]) => inFn(...a),
  maybeSingle: () => maybeSingle(),
} as const;

vi.mock('@/lib/supabaseClient', () => ({ supabase: { from: () => chain, rpc: (...a: unknown[]) => rpcFn(...a) } }));
// listRegistrationCycles delegates location attachment to @/lib/cycles — stub it deterministically.
vi.mock('@/lib/cycles', () => ({
  attachCycleLocations: vi.fn(async (cycles: { location_id?: string | null }[]) =>
    cycles.map((c) => ({ ...c, location: c.location_id ? { id: c.location_id, name: `Loc ${c.location_id}`, city: 'X' } : null }))),
}));

import {
  getRegistration,
  listRegistrations,
  registrationToCycle,
  listRegistrationCycles,
  createRegistration,
  updateRegistration,
  cycleInputToRegistrationInput,
  type Registration,
} from '@/lib/registrations';
import type { CycleInput } from '@/lib/cycles';

const cycleInput = (over: Partial<CycleInput> = {}): CycleInput => ({
  owner_type: 'academy',
  owner_id: 'a1',
  name: 'Zomer 2026',
  description: 'desc',
  start_date: '2026-06-01',
  end_date: '2026-08-01',
  enrollment_deadline: null,
  is_always_open: false,
  settings: { payment_methods: 'cash', scoring_weights: { x: 1 } },
  status: 'draft',
  type: 'registration',
  location_id: 'loc1',
  price_per_session: 30,
  total_price: 120,
  currency: 'EUR',
  terms: 'terms text',
  price_table: null,
  ...over,
});

const baseReg = (over: Partial<Registration> = {}): Registration => ({
  id: 'r1',
  source_cycle_id: 'c1',
  owner_type: 'academy',
  owner_id: 'a1',
  format: 'registration',
  name: 'Zomer 2026',
  description: null,
  start_date: '2026-04-01',
  end_date: '2026-06-24',
  enrollment_deadline: null,
  status: 'open',
  total_price: 120,
  currency: 'EUR',
  price_table: [{ label: 'Duo', price: 60 }],
  location_id: 'loc1',
  settings: { payment_methods: 'online' },
  terms: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  ...over,
});

describe('registrations lib', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getRegistration resolves by its own id (canonical)', async () => {
    maybeSingle.mockResolvedValueOnce({ data: { id: 'r1', source_cycle_id: 'c1' }, error: null });
    const r = await getRegistration('r1');
    expect(r?.id).toBe('r1');
    expect(maybeSingle).toHaveBeenCalledTimes(1); // direct hit → no legacy lookup
  });

  it('getRegistration falls back to the legacy source_cycle_id alias (old QR links)', async () => {
    maybeSingle
      .mockResolvedValueOnce({ data: null, error: null }) // not a registration id
      .mockResolvedValueOnce({ data: { id: 'r2', source_cycle_id: 'cyc' }, error: null });
    const r = await getRegistration('cyc');
    expect(r?.id).toBe('r2');
    expect(maybeSingle).toHaveBeenCalledTimes(2);
  });

  it('getRegistration returns null when neither matches', async () => {
    maybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: null, error: null });
    expect(await getRegistration('nope')).toBeNull();
  });

  it('listRegistrations returns the owner rows', async () => {
    order.mockResolvedValueOnce({ data: [{ id: 'r1' }, { id: 'r2' }], error: null });
    const rows = await listRegistrations('academy', 'a1');
    expect(rows.map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('listRegistrations throws on error', async () => {
    order.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    await expect(listRegistrations('academy', 'a1')).rejects.toBeTruthy();
  });

  it("registrationToCycle uses the registration's OWN id (canonical) + format→type", () => {
    const c = registrationToCycle(baseReg());
    expect(c.id).toBe('r1'); // the registration id — the canonical handle (NOT the legacy source cycle)
    expect(c.type).toBe('registration'); // format → type
    expect(c.total_price).toBe(120);
    expect(c.price_table).toEqual([{ label: 'Duo', price: 60 }]);
    expect(c.start_date).toBe('2026-04-01'); // span carried → per-lesson (price × weeks) stays correct
    expect(c.end_date).toBe('2026-06-24');
    expect(c.location_id).toBe('loc1');
    expect((c.settings as Record<string, unknown>).payment_methods).toBe('online');
  });

  it('registrationToCycle surfaces per-form terms (Lesreglement) onto the Cycle shape', () => {
    const c = registrationToCycle(baseReg({ terms: 'Betaling binnen 14 dagen.' }));
    expect(c.terms).toBe('Betaling binnen 14 dagen.');
  });

  it('createRegistration passes per-form terms to the RPC', async () => {
    rpcFn.mockResolvedValueOnce({ data: baseReg({ id: 'rT' }), error: null });
    await createRegistration({
      owner_type: 'academy', owner_id: 'a1', format: 'registration', name: 'F', terms: 'My rules',
    });
    expect(rpcFn.mock.calls[0][1]).toMatchObject({ p_terms: 'My rules' });
  });

  it('registrationToCycle tolerates an event with no price_table', () => {
    const c = registrationToCycle(baseReg({ format: 'event', price_table: null }));
    expect(c.type).toBe('event');
    expect(c.price_table).toBeNull();
  });

  it('listRegistrationCycles reads the registrations table + counts intakes by registration_id', async () => {
    order.mockResolvedValueOnce({ data: [baseReg({ id: 'r1' }), baseReg({ id: 'r2', location_id: null })], error: null });
    // count_registrations_intakes RPC → r1 has 3 applicants, r2 has none.
    rpcFn.mockResolvedValueOnce({ data: [{ registration_id: 'r1', n: 3 }], error: null });

    const rows = await listRegistrationCycles('academy', 'a1');

    expect(rpcFn).toHaveBeenCalledWith('count_registrations_intakes', { _registration_ids: ['r1', 'r2'] });
    expect(rows.map((r) => r.id).sort()).toEqual(['r1', 'r2']);
    expect(rows.find((r) => r.id === 'r1')!._intakeCount).toBe(3);
    expect(rows.find((r) => r.id === 'r2')!._intakeCount).toBe(0);
  });

  it('listRegistrationCycles attaches .location (regression: blank Locatie column)', async () => {
    order.mockResolvedValueOnce({ data: [baseReg({ id: 'r1', location_id: 'loc1' })], error: null });
    rpcFn.mockResolvedValueOnce({ data: [], error: null });

    const rows = await listRegistrationCycles('academy', 'a1');
    expect(rows[0].location).toEqual({ id: 'loc1', name: 'Loc loc1', city: 'X' });
  });

  it('createRegistration calls create_registration (standalone, no shell) + returns the row', async () => {
    rpcFn.mockResolvedValueOnce({ data: baseReg({ id: 'rNew' }), error: null });
    const r = await createRegistration({
      owner_type: 'academy', owner_id: 'a1', format: 'registration', name: 'New form',
      start_date: '2026-06-01', end_date: '2026-08-01',
      settings: { payment_methods: 'cash', scoring_weights: { x: 1 } },
    });
    expect(rpcFn).toHaveBeenCalledWith('create_registration', expect.objectContaining({
      p_owner_type: 'academy', p_owner_id: 'a1', p_format: 'registration', p_name: 'New form',
      p_start_date: '2026-06-01', p_end_date: '2026-08-01',
      p_settings: { payment_methods: 'cash', scoring_weights: { x: 1 } },
      p_status: 'draft', p_currency: 'EUR',
    }));
    // Per-form terms persist; the cycle-only is_always_open does not.
    const args = rpcFn.mock.calls[0][1] as Record<string, unknown>;
    expect('p_is_always_open' in args).toBe(false);
    expect('p_terms' in args).toBe(true);
    expect(r.id).toBe('rNew');
  });

  it('updateRegistration resolves the canonical id, keys update_registration on it, sends no owner params', async () => {
    maybeSingle.mockResolvedValueOnce({ data: baseReg({ id: 'r7' }), error: null }); // getRegistration resolve
    rpcFn.mockResolvedValueOnce({ data: baseReg({ id: 'r7' }), error: null });
    const r = await updateRegistration('r7', { format: 'event', name: 'Edited', status: 'open' });
    expect(rpcFn).toHaveBeenCalledWith('update_registration', expect.objectContaining({
      p_registration_id: 'r7', p_format: 'event', p_name: 'Edited', p_status: 'open',
    }));
    const args = rpcFn.mock.calls[0][1] as Record<string, unknown>;
    expect('p_owner_type' in args).toBe(false); // authorizes against the row's own owner
    expect('p_source_cycle_id' in args).toBe(false);
    expect(args.p_currency).toBeNull(); // unset → null → RPC keeps the existing value
    expect(r.id).toBe('r7');
  });

  it('updateRegistration throws when the registration cannot be resolved', async () => {
    maybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: null, error: null });
    await expect(updateRegistration('missing', { format: 'registration', name: 'X' })).rejects.toBeTruthy();
    expect(rpcFn).not.toHaveBeenCalled();
  });

  it('createRegistration throws on RPC error', async () => {
    rpcFn.mockResolvedValueOnce({ data: null, error: { message: 'not_authorized_for_owner' } });
    await expect(createRegistration({ owner_type: 'trainer', owner_id: 't1', format: 'registration', name: 'X' }))
      .rejects.toBeTruthy();
  });

  it('cycleInputToRegistrationInput maps type→format, keeps per-form terms, drops price_per_session / is_always_open', () => {
    const out = cycleInputToRegistrationInput(cycleInput({ type: 'registration', price_per_session: 30 }));
    expect(out.format).toBe('registration');
    expect('price_per_session' in out).toBe(false); // registrations have no per-session price
    expect(out.terms).toBe('terms text'); // per-form terms persist (shown to applicants)
    expect('is_always_open' in out).toBe(false);
    expect(out.settings).toEqual({ payment_methods: 'cash', scoring_weights: { x: 1 } });
    expect(out.owner_type).toBe('academy');
    expect(out.owner_id).toBe('a1');
    expect(out.total_price).toBe(120);
    expect(out.start_date).toBe('2026-06-01');
  });

  it('cycleInputToRegistrationInput maps an event cycle to format=event', () => {
    expect(cycleInputToRegistrationInput(cycleInput({ type: 'event' })).format).toBe('event');
  });

  it('cycleInputToRegistrationInput maps anything non-event (defensive) to format=registration', () => {
    expect(cycleInputToRegistrationInput(cycleInput({ type: 'cyclus' as never })).format).toBe('registration');
  });
});
