import { describe, it, expect, beforeEach, vi } from 'vitest';
import { supabaseMock, setMockData } from './fixtures/supabaseMock';

vi.mock('@/lib/supabaseClient', () => ({ supabase: supabaseMock }));

import { getMyPendingPriorityClaims } from '@/lib/priorityClaims';

/**
 * B1 (rebook go-live): the dashboard rebook card now reads through the SECURITY DEFINER
 * RPC get_my_pending_priority_claims, which surfaces claims keyed on the caller's profile OR
 * a linked guest record — so an academy/captain rebooking on behalf of a linked account-holder
 * shows up on their own dashboard. The client still collapses a weekly series into one card and
 * resolves the cycle's payment mode. A PGRST202 (RPC not deployed) falls back to the legacy
 * player_id-only direct read.
 */
const FUTURE = '2999-01-01T00:00:00Z';
const PAST = '2000-01-01T00:00:00Z';

beforeEach(() => setMockData({}));

describe('getMyPendingPriorityClaims — linked-guest aware (B1)', () => {
  it('collapses a weekly group to one card via the RPC and resolves the cycle payment mode', async () => {
    setMockData(
      { cycles: [{ id: 'cy1', settings: { rebook_payment_mode: 'upfront' }, start_date: '2026-09-01' }] },
      {
        get_my_pending_priority_claims: () => ({
          data: [
            // week 2 (later) — listed first to prove the EARLIEST session becomes the representative
            { id: 'c2', claim_token: 'tok-w2', slot_id: 's2', rebook_group_id: 'g1', start_time: '2026-09-08T17:00:00Z', end_time: '2026-09-08T18:00:00Z', cyclus_id: 'cy1', cyclus_name: 'Maandag 17:00', price_per_session: 12, priority_window_ends_at: FUTURE },
            // week 1 (earliest)
            { id: 'c1', claim_token: 'tok-w1', slot_id: 's1', rebook_group_id: 'g1', start_time: '2026-09-01T17:00:00Z', end_time: '2026-09-01T18:00:00Z', cyclus_id: 'cy1', cyclus_name: 'Maandag 17:00', price_per_session: 12, priority_window_ends_at: FUTURE },
          ],
          error: null,
        }),
      },
    );
    const claims = await getMyPendingPriorityClaims('me');
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      claim_token: 'tok-w1', // earliest representative drives the group accept/decline
      slot_id: 's1',
      sessions: 2,
      rebook_group_id: 'g1',
      rebook_payment_mode: 'upfront',
      start_date: '2026-09-01',
    });
    expect(claims[0].last_start_time).toBe('2026-09-08T17:00:00Z');
  });

  it('drops claims whose priority window has already closed', async () => {
    setMockData(
      {},
      {
        get_my_pending_priority_claims: () => ({
          data: [
            { id: 'c1', claim_token: 't1', slot_id: 's1', rebook_group_id: null, start_time: '2026-09-01T17:00:00Z', end_time: '2026-09-01T18:00:00Z', cyclus_id: null, cyclus_name: null, price_per_session: null, priority_window_ends_at: PAST },
          ],
          error: null,
        }),
      },
    );
    expect(await getMyPendingPriorityClaims('me')).toEqual([]);
  });

  it('falls back to the legacy player_id-only read when the RPC is not deployed (PGRST202)', async () => {
    setMockData(
      {
        slot_priority_claims: [
          { id: 'c1', claim_token: 't1', slot_id: 's1', rebook_group_id: null, player_id: 'me', status: 'pending', availability_slots: { start_time: '2026-09-01T17:00:00Z', end_time: '2026-09-01T18:00:00Z', cyclus_id: null, cyclus_name: 'Solo', price_per_session: 10, priority_window_ends_at: FUTURE } },
          { id: 'c2', claim_token: 't2', slot_id: 's2', rebook_group_id: null, player_id: 'other', status: 'pending', availability_slots: { start_time: '2026-09-02T17:00:00Z', end_time: '2026-09-02T18:00:00Z', cyclus_id: null, cyclus_name: 'NotMine', price_per_session: 10, priority_window_ends_at: FUTURE } },
        ],
      },
      { get_my_pending_priority_claims: () => ({ error: { code: 'PGRST202', message: 'function not found' } }) },
    );
    const claims = await getMyPendingPriorityClaims('me');
    expect(claims).toHaveLength(1); // only the row whose player_id = 'me' (the .eq filter)
    expect(claims[0].claim_token).toBe('t1');
  });

  it('THROWS on a cycles read error instead of silently showing deferred payment copy (round-6 #4)', async () => {
    // The RPC returns a claim carrying a cyclus_id, so the mode-resolution `cycles` read runs; that
    // read errors. Without the fix the card would default to 'deferred_split' + null start_date — an
    // UPFRONT rebook shown the wrong (pay-later, split) copy. With the fix it fails loud → react-query
    // renders the error/retry state instead.
    setMockData(
      {},
      {
        get_my_pending_priority_claims: () => ({
          data: [{ id: 'c1', claim_token: 't', slot_id: 's1', rebook_group_id: null, start_time: '2026-09-01T17:00:00Z', end_time: '2026-09-01T18:00:00Z', cyclus_id: 'cy1', cyclus_name: 'X', price_per_session: 10, priority_window_ends_at: FUTURE }],
          error: null,
        }),
      },
      { cycles: { message: 'cycles read boom' } },
    );
    await expect(getMyPendingPriorityClaims('me')).rejects.toThrow(/cycles read boom/);
  });
});
