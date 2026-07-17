import { describe, it, expect, vi } from 'vitest';
import {
  fetchPersonRefSet,
  fetchPersonBookingSlotIds,
  fetchPersonInvoices,
  type PersonRefSet,
} from './playerDetailData';

describe('fetchPersonRefSet (Phase 3.3b)', () => {
  it('maps the RPC row to the ref set (refs only — no identity/PII)', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ guest_ids: ['g1', 'g2'], profile_id: 'p1', has_login: true }],
      error: null,
    });
    const refs = await fetchPersonRefSet({ kind: 'academy', id: 'a1' }, { kind: 'guest', id: 'g1' }, { rpc });
    expect(rpc).toHaveBeenCalledWith('get_person_refs_for_scope', {
      p_scope: 'academy', p_scope_id: 'a1', p_guest_id: 'g1', p_profile_id: undefined,
    });
    expect(refs).toEqual({ guestIds: ['g1', 'g2'], profileId: 'p1', hasLogin: true });
  });

  it('falls back to the single clicked ref when the RPC is undeployed (PGRST202) — never blanks', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: 'PGRST202' } });
    const g = await fetchPersonRefSet({ kind: 'academy', id: 'a1' }, { kind: 'guest', id: 'g9' }, { rpc });
    expect(g).toEqual({ guestIds: ['g9'], profileId: null, hasLogin: undefined });
    const p = await fetchPersonRefSet({ kind: 'trainer', id: 't1' }, { kind: 'profile', id: 'p9' }, { rpc });
    expect(p).toEqual({ guestIds: [], profileId: 'p9', hasLogin: undefined });
  });

  it('falls back on a thrown error too', async () => {
    const rpc = vi.fn().mockRejectedValue(new Error('network'));
    const refs = await fetchPersonRefSet({ kind: 'academy', id: 'a1' }, { kind: 'guest', id: 'g1' }, { rpc });
    expect(refs.guestIds).toEqual(['g1']);
  });
});

function bookingsClient(rows: Record<string, Array<{ slot_id: string | null }>>) {
  // rows keyed by a signature of the filter applied
  const calls: string[] = [];
  const from = () => {
    const state = { guestIn: null as string[] | null, playerEq: null as string | null, pureProfile: false };
    const chain: Record<string, unknown> = {
      select: () => chain,
      in: (_col: string, vals: string[]) => { state.guestIn = vals; return chain; },
      eq: (_col: string, val: string) => { state.playerEq = val; return chain; },
      is: () => { state.pureProfile = true; return chain; },
      then: (resolve: (v: { data: Array<{ slot_id: string | null }> }) => unknown) => {
        const key = state.guestIn ? `g:${state.guestIn.join(',')}` : `p:${state.playerEq}`;
        calls.push(key);
        return Promise.resolve({ data: rows[key] ?? [] }).then(resolve);
      },
    };
    return chain;
  };
  return { from: from as never, calls };
}

describe('fetchPersonBookingSlotIds (Phase 3.3b)', () => {
  it('unions guest-side + pure-profile slot ids, deduped', async () => {
    const client = bookingsClient({
      'g:g1,g2': [{ slot_id: 's1' }, { slot_id: 's2' }, { slot_id: null }],
      'p:p1': [{ slot_id: 's2' }, { slot_id: 's3' }],
    });
    const refs: PersonRefSet = { guestIds: ['g1', 'g2'], profileId: 'p1' };
    const slots = await fetchPersonBookingSlotIds(refs, client);
    expect([...slots].sort()).toEqual(['s1', 's2', 's3']);
  });

  it('a guest-only person queries only the guest side', async () => {
    const client = bookingsClient({ 'g:g1': [{ slot_id: 's1' }] });
    const refs: PersonRefSet = { guestIds: ['g1'], profileId: null };
    expect(await fetchPersonBookingSlotIds(refs, client)).toEqual(['s1']);
    expect(client.calls).toEqual(['g:g1']); // no profile query
  });
});

describe('fetchPersonInvoices (Phase 3.3b)', () => {
  it('unions guest-addressed + profile-addressed invoices, deduped by id, newest first', async () => {
    const byFilter: Record<string, Array<{ id: string; invoice_date: string }>> = {
      g1: [{ id: 'i1', invoice_date: '2026-01-01' }],
      p1: [{ id: 'i2', invoice_date: '2026-03-01' }, { id: 'i1', invoice_date: '2026-01-01' }],
    };
    const from = () => {
      const state = { val: '' };
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (_col: string, val: string) => { if (val !== 'a1') state.val = val; return chain; },
        order: () => Promise.resolve({ data: byFilter[state.val] ?? [] }),
      };
      return chain;
    };
    const refs: PersonRefSet = { guestIds: ['g1'], profileId: 'p1' };
    const invoices = await fetchPersonInvoices({ kind: 'academy', id: 'a1' }, refs, { from: from as never });
    expect(invoices.map((i) => i.id)).toEqual(['i2', 'i1']); // deduped, newest first
  });
});
