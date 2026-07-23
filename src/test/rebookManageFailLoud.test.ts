import { describe, it, expect, vi, beforeEach } from 'vitest';
import { supabaseMock, setMockData } from './fixtures/supabaseMock';

vi.mock('@/lib/supabaseClient', () => ({ supabase: supabaseMock }));
// logger.warn must not touch PostHog in the unit env.
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { fetchGuestRebookReachable, getCycleRebookStatus } from '@/lib/rebookManage';

// A minimal but complete fixture for one academy cycle with a profile claim + a guest claim.
function baseData() {
  return {
    cycles: [{ id: 'cy1', name: 'Cycle', owner_type: 'academy', owner_id: 'ac1', settings: {} }],
    availability_slots: [{ id: 's1', cyclus_id: 'cy1', start_time: '2026-08-01T10:00:00Z', trainer_id: 't1', location_id: 'l1', max_participants: 4, is_public: false, public_release_status: null, priority_window_ends_at: null, member_window_starts_at: null, member_window_ends_at: null }],
    slot_priority_claims: [
      { id: 'c1', slot_id: 's1', player_id: 'p1', guest_player_id: null, status: 'claimed', rebook_group_id: null, invited_at: null, claim_token: null },
      { id: 'c2', slot_id: 's1', player_id: null, guest_player_id: 'g1', status: 'pending', rebook_group_id: null, invited_at: null, claim_token: null },
    ],
    invoices: [] as Array<Record<string, unknown>>,
    profiles_public: [{ id: 'p1', full_name: 'P One' }],
    guest_players: [{ id: 'g1', full_name: 'G One' }],
  };
}
const reachableRpc = { guests_have_rebook_contact: (a: { _guest_ids: string[] }) => ({ data: a._guest_ids.map((id) => ({ guest_id: id, has_contact: true })), error: null }) };

describe('fetchGuestRebookReachable (Codex round-5 #1: chunk + fail-loud, never silent absence)', () => {
  it('an empty id list makes NO rpc call and returns an empty set', async () => {
    const spy = vi.fn(() => ({ data: [], error: null }));
    setMockData({}, { guests_have_rebook_contact: spy });
    expect((await fetchGuestRebookReachable([])).size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('chunks >1000 ids into <=1000-id batches (never trips the RPC cap)', async () => {
    const ids = Array.from({ length: 1500 }, (_, i) => `g${i}`);
    const batches: number[] = [];
    setMockData({}, { guests_have_rebook_contact: (a: { _guest_ids: string[] }) => {
      batches.push(a._guest_ids.length);
      return { data: a._guest_ids.map((id) => ({ guest_id: id, has_contact: true })), error: null };
    } });
    const reachable = await fetchGuestRebookReachable(ids);
    expect(batches).toEqual([1000, 500]); // two bounded calls
    expect(reachable.size).toBe(1500);
    expect(reachable.has('g:g0')).toBe(true);
  });

  it('THROWS on an rpc error — never a silent empty set', async () => {
    setMockData({}, { guests_have_rebook_contact: () => ({ data: null, error: { message: 'boom' } }) });
    await expect(fetchGuestRebookReachable(['g1'])).rejects.toThrow(/boom/);
  });

  it('THROWS when a requested id is absent from the result (absence is not "no contact")', async () => {
    // Requested [g1, g2] but the RPC only returns g1 → g2 is an authorization/data anomaly, not emailless.
    setMockData({}, { guests_have_rebook_contact: () => ({ data: [{ guest_id: 'g1', has_contact: true }], error: null }) });
    await expect(fetchGuestRebookReachable(['g1', 'g2'])).rejects.toThrow(/missing/);
  });

  it('maps has_contact to the g:<id> key, dropping the unreachable', async () => {
    setMockData({}, { guests_have_rebook_contact: () => ({ data: [{ guest_id: 'g1', has_contact: true }, { guest_id: 'g2', has_contact: false }], error: null }) });
    const reachable = await fetchGuestRebookReachable(['g1', 'g2']);
    expect(reachable.has('g:g1')).toBe(true);
    expect(reachable.has('g:g2')).toBe(false);
  });
});

describe('getCycleRebookStatus fails loud as a class (Codex round-5 #2)', () => {
  beforeEach(() => setMockData(baseData(), reachableRpc));

  it('the happy path resolves WITHOUT throwing (guards against a vacuous always-throw)', async () => {
    const data = await getCycleRebookStatus('cy1');
    expect(data.cycleName).toBe('Cycle');
    expect(data.groups.length).toBeGreaterThan(0);
  });

  it('a CLAIM read failure (non-missing-column) throws — never a silent claim-less round', async () => {
    setMockData(baseData(), reachableRpc, { slot_priority_claims: { code: 'XX000', message: 'db unavailable' } });
    await expect(getCycleRebookStatus('cy1')).rejects.toThrow(/db unavailable/);
  });

  it('an INVOICE read failure throws — never labels paid rebookers as unpaid', async () => {
    setMockData(baseData(), reachableRpc, { invoices: { code: 'XX000', message: 'invoice read failed' } });
    await expect(getCycleRebookStatus('cy1')).rejects.toThrow(/invoice read failed/);
  });

  it('a CONTACT rpc failure throws — never renders a reachable member as unreachable', async () => {
    setMockData(baseData(), { guests_have_rebook_contact: () => ({ data: null, error: { message: 'contact rpc down' } }) });
    await expect(getCycleRebookStatus('cy1')).rejects.toThrow(/contact rpc down/);
  });
  // The 42703 deploy-window fallback (extended claim select missing → base-column retry) is preserved
  // by the isMissingColumn branch and pinned in rebookManageFetchAllPages.test.ts; the non-42703 throw
  // above is the new fail-loud behavior.
});
