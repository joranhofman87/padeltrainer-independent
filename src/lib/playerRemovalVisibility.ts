import { supabase } from '@/lib/supabaseClient';
import {
  shouldShowPlayerInAcademyOverview,
  type AcademyPlayerMetadataRemoval,
} from '@/lib/academyPlayerRemoval';
import {
  shouldShowPlayerInTrainerOverview,
  type TrainerPlayerMetadataRemoval,
} from '@/lib/trainerPlayerRemoval';
import type { PlayerMetadata } from '@/components/players/playerTagColors';

export type PlayerRemovalScope =
  | { kind: 'academy'; academyProfileId: string }
  | { kind: 'trainer'; trainerProfileId: string };

export type RemovedPlayerKeys = {
  guestIds: Set<string>;
  profileIds: Set<string>;
};

export const shouldShowPlayerInAcademyContext = shouldShowPlayerInAcademyOverview;

export const shouldShowPlayerInTrainerContext = shouldShowPlayerInTrainerOverview;

export type PlayerMetadataRemoval = AcademyPlayerMetadataRemoval | TrainerPlayerMetadataRemoval;

export function mergeRemovedPlayerKeys(...keySets: RemovedPlayerKeys[]): RemovedPlayerKeys {
  const guestIds = new Set<string>();
  const profileIds = new Set<string>();
  for (const keys of keySets) {
    keys.guestIds.forEach((id) => guestIds.add(id));
    keys.profileIds.forEach((id) => profileIds.add(id));
  }
  return { guestIds, profileIds };
}

/** Load guest/profile ids with removed_at set for a single academy or trainer scope. */
export async function fetchRemovedPlayerKeys(scope: PlayerRemovalScope): Promise<RemovedPlayerKeys> {
  let query = supabase
    .from('academy_player_metadata')
    .select('guest_player_id, profile_id, removed_at')
    .not('removed_at', 'is', null);

  if (scope.kind === 'academy') {
    query = query.eq('academy_profile_id', scope.academyProfileId);
  } else {
    query = query.eq('trainer_profile_id', scope.trainerProfileId);
  }

  const { data, error } = await query;
  if (error) throw error;

  const guestIds = new Set<string>();
  const profileIds = new Set<string>();
  (data || []).forEach((row) => {
    if (row.guest_player_id) guestIds.add(row.guest_player_id);
    if (row.profile_id) profileIds.add(row.profile_id);
  });
  return { guestIds, profileIds };
}

/** Academy calendar/booking: union academy removal + all academy trainer removals. */
export async function fetchRemovedPlayerKeysForAcademyContext(
  academyProfileId: string,
  trainerProfileIds: string[],
): Promise<RemovedPlayerKeys> {
  const academyKeys = await fetchRemovedPlayerKeys({
    kind: 'academy',
    academyProfileId,
  });

  if (trainerProfileIds.length === 0) {
    return academyKeys;
  }

  const { data, error } = await supabase
    .from('academy_player_metadata')
    .select('guest_player_id, profile_id')
    .in('trainer_profile_id', trainerProfileIds)
    .not('removed_at', 'is', null);

  if (error) throw error;

  const trainerKeys: RemovedPlayerKeys = { guestIds: new Set(), profileIds: new Set() };
  (data || []).forEach((row) => {
    if (row.guest_player_id) trainerKeys.guestIds.add(row.guest_player_id);
    if (row.profile_id) trainerKeys.profileIds.add(row.profile_id);
  });

  return mergeRemovedPlayerKeys(academyKeys, trainerKeys);
}

export function buildMetadataMaps(metadata: PlayerMetadata[]) {
  const metaByGuest = new Map<string, PlayerMetadata>();
  const metaByProfile = new Map<string, PlayerMetadata>();
  metadata.forEach((m) => {
    if (m.guest_player_id) metaByGuest.set(m.guest_player_id, m);
    if (m.profile_id) metaByProfile.set(m.profile_id, m);
  });
  return { metaByGuest, metaByProfile };
}

export function getMetadataForUnifiedPlayer(
  metaByGuest: Map<string, PlayerMetadata>,
  metaByProfile: Map<string, PlayerMetadata>,
  player: { id: string; type: 'guest' | 'registered' },
): PlayerMetadata | undefined {
  return player.type === 'guest'
    ? metaByGuest.get(player.id)
    : metaByProfile.get(player.id.replace(/^reg-/, ''));
}

export function filterUnifiedPlayersForActiveContext<
  T extends { id: string; type: 'guest' | 'registered' },
>(players: T[], metadata: PlayerMetadata[], context: 'academy' | 'trainer'): T[] {
  const { metaByGuest, metaByProfile } = buildMetadataMaps(metadata);
  const shouldShow =
    context === 'academy' ? shouldShowPlayerInAcademyContext : shouldShowPlayerInTrainerContext;

  return players.filter((p) => {
    const meta = getMetadataForUnifiedPlayer(metaByGuest, metaByProfile, p);
    return shouldShow(meta);
  });
}

export function filterGuestRowsByRemoval<T extends { id: string }>(
  guests: T[],
  keys: RemovedPlayerKeys,
): T[] {
  return guests.filter((g) => !keys.guestIds.has(g.id));
}

export function filterProfileIdsByRemoval(profileIds: string[], keys: RemovedPlayerKeys): string[] {
  return profileIds.filter((id) => !keys.profileIds.has(id));
}

export async function fetchActiveGuestPlayerCountForTrainer(trainerProfileId: string): Promise<number> {
  const { data: guests, error } = await supabase
    .from('guest_players')
    .select('id')
    .eq('trainer_id', trainerProfileId);

  if (error) throw error;
  if (!guests?.length) return 0;

  const keys = await fetchRemovedPlayerKeys({ kind: 'trainer', trainerProfileId });
  return filterGuestRowsByRemoval(guests, keys).length;
}
