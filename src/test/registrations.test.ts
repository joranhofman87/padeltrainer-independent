import { describe, it, expect, vi, beforeEach } from 'vitest';

const maybeSingle = vi.fn();
const order = vi.fn();
// Chainable builder: select/eq return the chain; maybeSingle/order are the terminal resolvers.
const chain = {
  select: () => chain,
  eq: () => chain,
  order: (...a: unknown[]) => order(...a),
  maybeSingle: () => maybeSingle(),
} as const;

vi.mock('@/lib/supabaseClient', () => ({ supabase: { from: () => chain } }));

import { getRegistration, listRegistrations } from '@/lib/registrations';

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
});
