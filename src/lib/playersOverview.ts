/**
 * Client for the server-side players overview (get_players_overview RPC) —
 * the single source of truth for who appears in academy/trainer player views,
 * with server-side search, filters, sort and pagination (no PostgREST
 * 1000-row truncation: pages are explicit, totals exact).
 */
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { supabase } from '@/lib/supabaseClient';
import { playerKeys, type PlayerScope } from '@/lib/playerQueryKeys';
import type { Database } from '@/integrations/supabase/types';

export type PlayersOverviewRow =
  Database['public']['Functions']['get_players_overview']['Returns'][number];

export type LevelBand = 'beginner' | 'intermediate' | 'advanced' | 'pro' | 'unrated';

export interface PlayersOverviewFilters {
  trainerId?: string | null;
  locationId?: string | null;
  levelBand?: LevelBand | null;
  hasActiveCyclus?: boolean | null;
  tagId?: string | null; // uuid or 'untagged'
  payment?: 'overdue' | 'ok' | null;
}

export interface PlayersOverviewParams {
  search?: string;
  filters?: PlayersOverviewFilters;
  sort?: 'name' | 'email' | 'skill' | 'created_at';
  sortDir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

/** Half-open band encoding matching the page's getLevelBand exactly:
 * beginner (null,3], intermediate (3,6], advanced (6,9], pro (9,null). */
export function filtersToRpcJson(filters: PlayersOverviewFilters = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (filters.trainerId) out.trainer_id = filters.trainerId;
  if (filters.locationId) out.location_id = filters.locationId;
  switch (filters.levelBand) {
    case 'beginner': out.level_max = 3; break;
    case 'intermediate': out.level_gt = 3; out.level_max = 6; break;
    case 'advanced': out.level_gt = 6; out.level_max = 9; break;
    case 'pro': out.level_gt = 9; break;
    case 'unrated': out.level_unrated = true; break;
  }
  if (typeof filters.hasActiveCyclus === 'boolean') out.has_active_cyclus = filters.hasActiveCyclus;
  if (filters.tagId) out.tag_id = filters.tagId;
  if (filters.payment) out.payment = filters.payment;
  return out;
}

export async function fetchPlayersOverview(
  scope: PlayerScope,
  params: PlayersOverviewParams = {},
): Promise<{ rows: PlayersOverviewRow[]; total: number }> {
  const pageSize = params.pageSize ?? 50;
  const page = params.page ?? 0;
  const { data, error } = await supabase.rpc('get_players_overview', {
    p_scope: scope.kind,
    p_scope_id: scope.id,
    p_search: params.search?.trim() || undefined,
    p_filters: filtersToRpcJson(params.filters) as never,
    p_sort: params.sort ?? 'name',
    p_sort_dir: params.sortDir ?? 'asc',
    p_limit: pageSize,
    p_offset: page * pageSize,
  });
  if (error) throw error;
  const rows = (data ?? []) as PlayersOverviewRow[];
  return { rows, total: Number(rows[0]?.total_count ?? 0) };
}

/**
 * Fetch EVERY matching player by paging through the RPC (deterministic order
 * guaranteed server-side). Replaces unbounded selects that silently truncated
 * at PostgREST's 1000-row cap. Hard safety cap: 100 pages (20k players).
 */
export async function fetchAllPlayersOverview(
  scope: PlayerScope,
  params: Omit<PlayersOverviewParams, 'page' | 'pageSize'> = {},
): Promise<PlayersOverviewRow[]> {
  const pageSize = 200;
  const all: PlayersOverviewRow[] = [];
  for (let page = 0; page < 100; page++) {
    const { rows, total } = await fetchPlayersOverview(scope, { ...params, page, pageSize });
    all.push(...rows);
    if (all.length >= total || rows.length === 0) return all;
  }
  throw new Error('fetchAllPlayersOverview: exceeded 100-page safety cap (20k players)');
}

export function usePlayersOverview(
  scope: { kind: PlayerScope['kind']; id: string | undefined | null },
  params: PlayersOverviewParams = {},
) {
  return useQuery({
    queryKey: playerKeys.overview(scope.kind, scope.id, params),
    queryFn: () => fetchPlayersOverview({ kind: scope.kind, id: scope.id! }, params),
    enabled: Boolean(scope.id),
    placeholderData: keepPreviousData,
  });
}
