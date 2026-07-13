import { describe, it, expect, vi, beforeEach } from 'vitest';

const maybeSingle = vi.fn();
const order = vi.fn();
const inFn = vi.fn();
const rpcFn = vi.fn();
// Chainable builder: select/eq return the chain; maybeSingle/order/in are the terminal resolvers.
const chain = {
  select: () => chain,
  eq: () => chain,
  order: (...a: unknown[]) => order(...a),
  in: (...a: unknown[]) => inFn(...a),
  maybeSingle: () => maybeSingle(),
} as const;

vi.mock('@/lib/supabaseClient', () => ({ supabase: { from: () => chain, rpc: (...a: unknown[]) => rpcFn(...a) } }));
// listRegistrationCycles delegates the legacy half to getCyclesWithCounts — stub it so the test
// exercises only the merge/dedupe/count logic.
vi.mock('@/lib/cycles', () => ({
  getCyclesWithCounts: vi.fn(),
  countCyclesIntakesWithFallback: vi.fn(),
  // Mirror the real helper deterministically: attach {id,name,city} from each cycle's location_id.
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
  isMissingRegistrationRpc,
  type Registration,
} from '@/lib/registrations';
import { getCyclesWithCounts, countCyclesIntakesWithFallback } from '@/lib/cycles';
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

  it('getRegistration falls back to legacy cycle id (source_cycle_id)', async () => {
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

  it('registrationToCycle maps the form onto the source cycle id + format→type', () => {
    const c = registrationToCycle(baseReg());
    expect(c.id).toBe('c1'); // SOURCE cycle id, not the registration id — drives intake.cycle_id
    expect(c.type).toBe('registration'); // format → type
    expect(c.total_price).toBe(120);
    expect(c.price_table).toEqual([{ label: 'Duo', price: 60 }]);
    expect(c.start_date).toBe('2026-04-01'); // span carried → per-lesson (price × weeks) stays correct
    expect(c.end_date).toBe('2026-06-24');
    expect(c.location_id).toBe('loc1');
    expect((c.settings as Record<string, unknown>).payment_methods).toBe('online');
  });

  it('registrationToCycle tolerates an event with no price_table', () => {
    const c = registrationToCycle(baseReg({ format: 'event', price_table: null }));
    expect(c.type).toBe('event');
    expect(c.price_table).toBeNull();
  });

  it('listRegistrationCycles dedupes by source cycle id (migrated registration wins) + counts intakes', async () => {
    // Legacy half: one un-migrated cycle (cOld) + one cycle (c1) that has ALSO been migrated.
    vi.mocked(getCyclesWithCounts).mockResolvedValueOnce([
      { id: 'cOld', type: 'event', created_at: '2026-03-01T00:00:00Z', _intakeCount: 2 },
      { id: 'c1', type: 'registration', created_at: '2026-01-01T00:00:00Z', _intakeCount: 99 },
    ] as never);
    // Registrations half: the migrated form for c1.
    order.mockResolvedValueOnce({ data: [baseReg({ id: 'r1', source_cycle_id: 'c1' })], error: null });
    // Intake count for the migrated source cycle c1 → two (via the indexed count RPC helper).
    vi.mocked(countCyclesIntakesWithFallback).mockResolvedValueOnce(new Map([['c1', 2]]));

    const rows = await listRegistrationCycles('academy', 'a1');

    // c1 appears ONCE (the migrated registration, not the legacy duplicate); cOld stays.
    expect(rows.map((r) => r.id).sort()).toEqual(['c1', 'cOld']);
    const c1 = rows.find((r) => r.id === 'c1')!;
    expect(c1.type).toBe('registration'); // from the mapped registration, not the legacy '99' row
    expect(c1._intakeCount).toBe(2); // counted from intake_requests, not the stale legacy count
  });

  it('listRegistrationCycles attaches .location to migrated rows (regression: blank Locatie column)', async () => {
    // A cycle migrated to the registrations table: registrationToCycle carries location_id but NO
    // joined `.location`, and it OVERWRITES the legacy embed → the Locatie column would go blank.
    vi.mocked(getCyclesWithCounts).mockResolvedValueOnce([
      { id: 'c1', type: 'registration', created_at: '2026-01-01T00:00:00Z', location: { id: 'loc1', name: 'Old', city: 'X' } },
    ] as never);
    order.mockResolvedValueOnce({ data: [baseReg({ id: 'r1', source_cycle_id: 'c1' })], error: null });
    vi.mocked(countCyclesIntakesWithFallback).mockResolvedValueOnce(new Map([['c1', 0]]));

    const rows = await listRegistrationCycles('academy', 'a1');
    const c1 = rows.find((r) => r.id === 'c1')!;
    // attachCycleLocations must re-attach `.location` on the merged set (incl. the migrated winner).
    expect(c1.location).toEqual({ id: 'loc1', name: 'Loc loc1', city: 'X' });
  });

  it('createRegistration calls create_registration_with_cycle with mapped params (FULL settings — RPC splits) + returns the row', async () => {
    rpcFn.mockResolvedValueOnce({ data: baseReg({ id: 'rNew', source_cycle_id: 'cNew' }), error: null });
    const r = await createRegistration({
      owner_type: 'academy', owner_id: 'a1', format: 'registration', name: 'New form',
      start_date: '2026-06-01', end_date: '2026-08-01',
      settings: { payment_methods: 'cash', scoring_weights: { x: 1 } }, // full → RPC keeps form subset
    });
    expect(rpcFn).toHaveBeenCalledWith('create_registration_with_cycle', expect.objectContaining({
      p_owner_type: 'academy', p_owner_id: 'a1', p_format: 'registration', p_name: 'New form',
      p_start_date: '2026-06-01', p_end_date: '2026-08-01',
      p_settings: { payment_methods: 'cash', scoring_weights: { x: 1 } },
      p_status: 'draft', p_currency: 'EUR', p_is_always_open: false,
    }));
    expect(r.id).toBe('rNew');
  });

  it('updateRegistration is keyed on the source cycle, sends no owner params, and passes null (RPC preserves) for unset fields', async () => {
    rpcFn.mockResolvedValueOnce({ data: baseReg({ source_cycle_id: 'cEdit' }), error: null });
    const r = await updateRegistration('cEdit', { format: 'event', name: 'Edited', status: 'open' });
    expect(rpcFn).toHaveBeenCalledWith('update_registration_with_cycle', expect.objectContaining({
      p_source_cycle_id: 'cEdit', p_format: 'event', p_name: 'Edited', p_status: 'open',
    }));
    const args = rpcFn.mock.calls[0][1] as Record<string, unknown>;
    expect('p_owner_type' in args).toBe(false); // authorizes against the existing cycle, not caller input
    expect(args.p_currency).toBeNull(); // unset → null → RPC keeps the existing value
    expect(args.p_is_always_open).toBeNull();
    expect(r.source_cycle_id).toBe('cEdit');
  });

  it('createRegistration throws on RPC error', async () => {
    rpcFn.mockResolvedValueOnce({ data: null, error: { message: 'not_authorized_for_owner' } });
    await expect(createRegistration({ owner_type: 'trainer', owner_id: 't1', format: 'registration', name: 'X' }))
      .rejects.toBeTruthy();
  });

  it('cycleInputToRegistrationInput maps type→format, DROPS price_per_session, passes FULL settings through', () => {
    const out = cycleInputToRegistrationInput(cycleInput({ type: 'registration', price_per_session: 30 }));
    expect(out.format).toBe('registration');
    expect('price_per_session' in out).toBe(false); // registrations have no per-session price
    expect(out.settings).toEqual({ payment_methods: 'cash', scoring_weights: { x: 1 } }); // FULL — the RPC splits
    expect(out.owner_type).toBe('academy');
    expect(out.owner_id).toBe('a1');
    expect(out.total_price).toBe(120);
    expect(out.terms).toBe('terms text');
    expect(out.start_date).toBe('2026-06-01');
    expect(out.is_always_open).toBe(false);
  });

  it('cycleInputToRegistrationInput maps an event cycle to format=event', () => {
    expect(cycleInputToRegistrationInput(cycleInput({ type: 'event' })).format).toBe('event');
  });

  it('cycleInputToRegistrationInput maps anything non-event (defensive) to format=registration', () => {
    expect(cycleInputToRegistrationInput(cycleInput({ type: 'cyclus' as never })).format).toBe('registration');
  });

  it('isMissingRegistrationRpc is true only for the not-deployed RPC codes', () => {
    expect(isMissingRegistrationRpc({ code: 'PGRST202' })).toBe(true);
    expect(isMissingRegistrationRpc({ code: '42883' })).toBe(true);
    expect(isMissingRegistrationRpc({ code: '23505' })).toBe(false); // a real DB error rethrows
    expect(isMissingRegistrationRpc(null)).toBe(false);
    expect(isMissingRegistrationRpc(new Error('boom'))).toBe(false);
  });
});
