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
  it('collects every page until total reached', async () => {
    const total = 450;
    rpcMock.mockImplementation((_fn: string, args: { p_offset: number; p_limit: number }) => {
      const start = args.p_offset;
      const rows = Array.from({ length: Math.min(args.p_limit, total - start) }, (_, i) => ({
        player_key: `g_${start + i}`,
        total_count: total,
      }));
      return Promise.resolve({ data: rows, error: null });
    });
    const all = await fetchAllPlayersOverview({ kind: 'academy', id: 'a1' });
    expect(all).toHaveLength(450);
    expect(new Set(all.map((r) => r.player_key)).size).toBe(450);
    expect(rpcMock).toHaveBeenCalledTimes(3); // 200 + 200 + 50
  });

  it('throws past the 100-page safety cap instead of looping forever', async () => {
    rpcMock.mockResolvedValue({
      data: Array.from({ length: 200 }, (_, i) => ({ player_key: `g_${i}`, total_count: 999999 })),
      error: null,
    });
    await expect(fetchAllPlayersOverview({ kind: 'academy', id: 'a1' })).rejects.toThrow('safety cap');
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
