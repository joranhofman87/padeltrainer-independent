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

/**
 * The view-model the trainer + academy player lists render. Both pages previously declared this type
 * + the row→model mapper near-identically; this is the single shared source. The academy-only fields
 * (trainer_*, training_location_ids) are populated only in academy mode (see mapPlayersOverviewRow).
 */
export interface UnifiedPlayer {
  id: string;
  full_name: string;
  email: string;
  phone: string;
  billing_business_name: string | null;
  skill_rating: number | null;
  rating_system: string;
  has_trained: boolean;
  notes: string | null;
  created_at: string;
  type: 'guest' | 'registered';
  location_names?: string[];
  has_active_cyclus?: boolean;
  source?: string | null;
  birth_date?: string | null;
  metadata_id?: string;
  tag_ids?: string[];
  /** Internal coaching note — both roles read it from the row's `academy_notes` column. */
  internal_notes?: string;
  guest_player_id?: string | null;
  profile_id?: string | null;
  has_overdue_payment?: boolean;
  email_undeliverable?: boolean;
  // Academy-only (undefined in trainer mode):
  trainer_id?: string;
  trainer_ids?: string[];
  trainer_name?: string;
  training_location_ids?: string[];
}

export interface MapPlayerOpts {
  /**
   * Academy mode: resolve guest/registered player trainer display names + the "Academy" fallback
   * label. Omit for trainer mode (the trainer_* fields stay undefined).
   */
  trainerNames?: { map: Map<string, string>; academyLabel: string };
}

/** Map a server players-overview row to the shared UnifiedPlayer view-model. */
export function mapPlayersOverviewRow(row: PlayersOverviewRow, opts: MapPlayerOpts = {}): UnifiedPlayer {
  const player: UnifiedPlayer = {
    id: row.guest_player_id ?? `reg-${row.profile_id}`,
    full_name: row.full_name,
    email: row.email,
    phone: row.phone,
    billing_business_name: row.billing_business_name,
    skill_rating: row.skill_rating,
    rating_system: row.rating_system,
    has_trained: row.has_trained,
    notes: row.notes,
    created_at: row.created_at,
    type: row.player_type as 'guest' | 'registered',
    location_names: row.location_names ?? [],
    has_active_cyclus: row.has_active_cyclus,
    source: row.source,
    birth_date: row.birth_date,
    metadata_id: row.metadata_id ?? undefined,
    tag_ids: row.tag_ids ?? [],
    internal_notes: row.academy_notes ?? '',
    guest_player_id: row.guest_player_id,
    profile_id: row.profile_id,
    has_overdue_payment: row.has_overdue_payment,
    email_undeliverable: row.email_undeliverable,
  };
  if (opts.trainerNames) {
    const { map, academyLabel } = opts.trainerNames;
    player.trainer_id = row.owner_trainer_id ?? undefined;
    player.trainer_ids = row.trainer_ids ?? [];
    player.trainer_name =
      row.player_type === 'guest'
        ? row.owner_trainer_id
          ? map.get(row.owner_trainer_id) || '—'
          : academyLabel
        : row.trainer_ids?.length
          ? map.get(row.trainer_ids[0]) || '—'
          : '—';
    player.training_location_ids = row.location_ids ?? [];
  }
  return player;
}

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

// get_players_overview clamps p_limit at 500 server-side; request that maximum
// so a full fetch needs the fewest possible pipeline runs.
const FETCH_ALL_PAGE_SIZE = 500;
const FETCH_ALL_MAX_ROWS = 20_000;
const FETCH_ALL_CONCURRENCY = 5;

/**
 * Fetch EVERY matching player by paging through the RPC (deterministic order
 * guaranteed server-side). Replaces unbounded selects that silently truncated
 * at PostgREST's 1000-row cap. Hard safety cap: 20k players.
 *
 * P-02: the previous version walked 200-row pages sequentially, so the RPC
 * re-ran its whole membership/filter/sort pipeline once per page (50 full
 * re-runs at 10k players, one round-trip each). The RPC has no keyset cursor
 * and clamps p_limit at 500, so per-page recomputation can't be fully
 * eliminated client-side; instead page 0's exact window total plans all
 * remaining offsets up front, pages use the maximum size (2.5x fewer pipeline
 * runs) and run concurrently in bounded batches. Offsets follow the page size
 * the server actually honored, so a lower server-side clamp can never open
 * gaps; rows are deduped by player_key in case data shifts mid-fetch (the old
 * sequential walk had the same hazard, unguarded).
 */
export async function fetchAllPlayersOverview(
  scope: PlayerScope,
  params: Omit<PlayersOverviewParams, 'page' | 'pageSize'> = {},
): Promise<PlayersOverviewRow[]> {
  const first = await fetchPlayersOverview(scope, { ...params, page: 0, pageSize: FETCH_ALL_PAGE_SIZE });
  if (first.total > FETCH_ALL_MAX_ROWS) {
    throw new Error('fetchAllPlayersOverview: exceeded safety cap (20k players)');
  }
  if (first.rows.length === 0 || first.rows.length >= first.total) return first.rows;

  const effectiveSize = first.rows.length;
  const pageCount = Math.ceil(first.total / effectiveSize);
  const pages: PlayersOverviewRow[][] = [first.rows];
  for (let batchStart = 1; batchStart < pageCount; batchStart += FETCH_ALL_CONCURRENCY) {
    const batchEnd = Math.min(batchStart + FETCH_ALL_CONCURRENCY, pageCount);
    const batch: Promise<void>[] = [];
    for (let page = batchStart; page < batchEnd; page++) {
      batch.push(
        fetchPlayersOverview(scope, { ...params, page, pageSize: effectiveSize }).then(({ rows }) => {
          pages[page] = rows;
        }),
      );
    }
    await Promise.all(batch);
  }

  const seen = new Set<string>();
  const all: PlayersOverviewRow[] = [];
  for (const rows of pages) {
    for (const row of rows ?? []) {
      if (seen.has(row.player_key)) continue;
      seen.add(row.player_key);
      all.push(row);
    }
  }
  return all;
}

/** Guest-player shape the booking dialogs consume (matches AddPlayerDialog's GuestPlayer). */
export interface BookableGuestPlayer {
  id: string;
  trainer_id: string | null;
  academy_profile_id: string | null;
  first_name: string | null;
  last_name: string | null;
  full_name: string;
  email: string;
  phone: string;
  skill_rating: number | null;
  rating_system: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
  linked_profile_id: string | null;
}

/**
 * Bookable players for the add-to-cyclus/slot pickers — the SAME membership
 * as the players table (overview RPC: academy-level guests + active trainers'
 * guests, removal-filtered, linked identity from the live profile), reduced to
 * rows with a guest record because the booking pipeline books by
 * guest_player_id. Registered players without a guest record are not bookable
 * through this flow (they book themselves).
 */
export async function fetchBookableGuestPlayers(
  scope: PlayerScope,
): Promise<BookableGuestPlayer[]> {
  const rows = await fetchAllPlayersOverview(scope);
  return rows
    .filter((row) => Boolean(row.guest_player_id))
    .map((row) => ({
      id: row.guest_player_id as string,
      trainer_id: row.owner_trainer_id ?? null,
      academy_profile_id: scope.kind === 'academy' && !row.owner_trainer_id ? scope.id : null,
      first_name: null,
      last_name: null,
      full_name: row.full_name,
      email: row.email,
      phone: row.phone,
      skill_rating: row.skill_rating ?? null,
      rating_system: row.rating_system,
      notes: row.notes ?? null,
      created_at: row.created_at,
      updated_at: row.created_at,
      linked_profile_id: row.profile_id ?? null,
    }));
}

/**
 * A bookable person for the roster pickers — person-unification Phase 0. Unlike
 * {@link fetchBookableGuestPlayers} (guest rows only; five other surfaces depend on `id ===
 * guest_player_id`), this returns BOTH guests and registered players, each with a namespaced
 * `comboboxId` so the picker can tell them apart. A registered (`p_`) selection is resolved to a
 * guest twin at the call site before booking; the money chain stays guest-keyed.
 */
export interface BookablePerson {
  /** `g_<guestPlayerId>` for a guest, `p_<profileId>` for a registered player. Stable picker key. */
  comboboxId: string;
  guestPlayerId: string | null;
  /** Set only on registered (`p_`) rows; FAM-02: guest rows carry profile_id NULL. */
  profileId: string | null;
  full_name: string;
  email: string;
  phone: string;
  skill_rating: number | null;
  rating_system: string;
  birth_date: string | null;
}

/**
 * Bookable people (guests + registered) for the cycle/slot roster pickers, from the same
 * SECURITY DEFINER overview RPC as the players table (so an academy manager sees names/emails they
 * cannot RLS-read from `profiles` directly). Registered players surface here so they can be added
 * as participants; the caller mints/reuses their guest twin.
 */
export async function fetchBookablePersons(scope: PlayerScope): Promise<BookablePerson[]> {
  const rows = await fetchAllPlayersOverview(scope);
  return rows
    .filter((row) => Boolean(row.guest_player_id) || Boolean(row.profile_id))
    .map((row) => {
      const guestPlayerId = row.guest_player_id ?? null;
      const profileId = guestPlayerId ? null : (row.profile_id ?? null);
      return {
        comboboxId: guestPlayerId ? `g_${guestPlayerId}` : `p_${profileId}`,
        guestPlayerId,
        profileId,
        full_name: row.full_name,
        email: row.email,
        phone: row.phone,
        skill_rating: row.skill_rating ?? null,
        rating_system: row.rating_system,
        birth_date: row.birth_date ?? null,
      };
    });
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
