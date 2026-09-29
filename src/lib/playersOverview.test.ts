import { describe, expect, it, vi, beforeEach } from 'vitest';
import { filtersToRpcJson, fetchPlayersOverview, fetchAllPlayersOverview } from './playersOverview';
import { playerKeys, invalidateAllPlayerData } from './playerQueryKeys';
import type { QueryClient } from '@tanstack/react-query';

const rpcMock = vi.fn();
vi.mock('@/lib/supabaseClient', () => ({
  supabase: { rpc: (...args: unknown[]) => rpcMock(...args) },
}));

beforeEach(() => {
  rpcMock.mockReset();
});

describe('filtersToRpcJson — level band boundaries', () => {
  it('maps bands to half-open ranges matching getLevelBand', () => {
    expect(filtersToRpcJson({ levelBand: 'beginner' })).toEqual({ level_max: 3 });
    expect(filtersToRpcJson({ levelBand: 'intermediate' })).toEqual({ level_gt: 3, level_max: 6 });
    expect(filtersToRpcJson({ levelBand: 'advanced' })).toEqual({ level_gt: 6, level_max: 9 });
    expect(filtersToRpcJson({ levelBand: 'pro' })).toEqual({ level_gt: 9 });
    expect(filtersToRpcJson({ levelBand: 'unrated' })).toEqual({ level_unrated: true });
  });

  it('passes through the other filters and skips empties', () => {
    expect(filtersToRpcJson({ trainerId: 't1', tagId: 'untagged', payment: 'overdue', hasActiveCyclus: false }))
      .toEqual({ trainer_id: 't1', tag_id: 'untagged', payment: 'overdue', has_active_cyclus: false });
    expect(filtersToRpcJson({})).toEqual({});
    expect(filtersToRpcJson({ trainerId: null, locationId: undefined })).toEqual({});
  });
});

describe('fetchPlayersOverview', () => {
  it('returns rows + total from the window count', async () => {
    rpcMock.mockResolvedValue({
      data: [
        { player_key: 'g_1', total_count: 7 },
        { player_key: 'p_2', total_count: 7 },
      ],
      error: null,
    });
    const { rows, total } = await fetchPlayersOverview({ kind: 'academy', id: 'a1' }, { page: 1, pageSize: 2 });
    expect(rows).toHaveLength(2);
    expect(total).toBe(7);
    expect(rpcMock).toHaveBeenCalledWith('get_players_overview', expect.objectContaining({
      p_scope: 'academy', p_scope_id: 'a1', p_limit: 2, p_offset: 2,
    }));
  });

  it('returns total 0 on empty result', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    const { rows, total } = await fetchPlayersOverview({ kind: 'trainer', id: 't1' });
    expect(rows).toHaveLength(0);
    expect(total).toBe(0);
  });

  it('throws on rpc error', async () => {
    rpcMock.mockResolvedValue({ data: null, error: new Error('boom') });
    await expect(fetchPlayersOverview({ kind: 'academy', id: 'a1' })).rejects.toThrow('boom');
  });
});

describe('fetchAllPlayersOverview — page-through', () => {
  /** Serves a dataset of `total` rows honoring p_limit/p_offset (clamped at `serverClamp`). */
  const serveTotal = (total: number, serverClamp = 500) =>
    rpcMock.mockImplementation((_fn: string, args: { p_offset: number; p_limit: number }) => {
      const start = args.p_offset;
      const limit = Math.min(args.p_limit, serverClamp);
      const rows = Array.from({ length: Math.max(Math.min(limit, total - start), 0) }, (_, i) => ({
        player_key: `g_${start + i}`,
        total_count: total,
      }));
      return Promise.resolve({ data: rows, error: null });
    });

  it('fetches a small set in a single max-size page', async () => {
    serveTotal(450);
    const all = await fetchAllPlayersOverview({ kind: 'academy', id: 'a1' });
    expect(all).toHaveLength(450);
    expect(new Set(all.map((r) => r.player_key)).size).toBe(450);
    expect(rpcMock).toHaveBeenCalledTimes(1); // P-02: was 3 sequential 200-row pipeline runs
  });

  it('plans the remaining pages from page 0 total and keeps order + uniqueness', async () => {
    serveTotal(1200);
    const all = await fetchAllPlayersOverview({ kind: 'academy', id: 'a1' });
    expect(all).toHaveLength(1200);
    expect(all[0].player_key).toBe('g_0');
    expect(all[1199].player_key).toBe('g_1199');
    expect(new Set(all.map((r) => r.player_key)).size).toBe(1200);
    expect(rpcMock).toHaveBeenCalledTimes(3); // 500 + 500 + 200
    const offsets = rpcMock.mock.calls.map((c) => (c[1] as { p_offset: number }).p_offset).sort((a, b) => a - b);
    expect(offsets).toEqual([0, 500, 1000]);
  });

  it('aligns offsets to the page size the server actually honored', async () => {
    serveTotal(450, 200); // hypothetical tighter server clamp — no gaps allowed
    const all = await fetchAllPlayersOverview({ kind: 'academy', id: 'a1' });
    expect(all).toHaveLength(450);
    expect(new Set(all.map((r) => r.player_key)).size).toBe(450);
    const offsets = rpcMock.mock.calls.map((c) => (c[1] as { p_offset: number }).p_offset).sort((a, b) => a - b);
    expect(offsets).toEqual([0, 200, 400]);
  });

  it('throws past the safety cap instead of fetching unbounded pages', async () => {
    serveTotal(999999);
    await expect(fetchAllPlayersOverview({ kind: 'academy', id: 'a1' })).rejects.toThrow('safety cap');
    expect(rpcMock).toHaveBeenCalledTimes(1); // detected on page 0, nothing else fired
  });
});

describe('playerKeys + invalidateAllPlayerData', () => {
  it('keys nest under the scope subtree', () => {
    expect(playerKeys.scope('academy', 'a1')).toEqual(['players', 'academy', 'a1']);
    expect(playerKeys.overview('academy', 'a1', { p: 1 })).toEqual(['players', 'academy', 'a1', 'overview', { p: 1 }]);
    expect(playerKeys.campaignAll('trainer', 't1')).toEqual(['players', 'trainer', 't1', 'campaign-all']);
    expect(playerKeys.picker('academy', 'a1', 'jan')).toEqual(['players', 'academy', 'a1', 'picker', 'jan']);
  });

  it('scope invalidation targets the subtree; bare call targets all players', () => {
    const calls: unknown[] = [];
    const qc = { invalidateQueries: (arg: unknown) => { calls.push(arg); return Promise.resolve(); } } as unknown as QueryClient;
    invalidateAllPlayerData(qc, { kind: 'academy', id: 'a1' });
    invalidateAllPlayerData(qc);
    expect(calls).toEqual([
      { queryKey: ['players', 'academy', 'a1'] },
      { queryKey: ['players'] },
    ]);
  });

  it('legacy factories alias into the subtree', async () => {
    const { academyPlayersQueryKey } = await import('./academyPlayersQuery');
    const { trainerPlayersQueryKey } = await import('./trainerPlayersQuery');
    expect(academyPlayersQueryKey('a1')).toEqual(['players', 'academy', 'a1']);
    expect(trainerPlayersQueryKey('t1')).toEqual(['players', 'trainer', 't1']);
  });
});
