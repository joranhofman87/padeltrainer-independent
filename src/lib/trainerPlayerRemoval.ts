import { supabase } from '@/lib/supabaseClient';
import { isTrainerRegisteredPlayerVisible } from '@/lib/invoiceSelectablePlayers';

export type TrainerPlayerRemovalKey = {
  guestPlayerId: string | null;
  profileId: string | null;
};

export type TrainerPlayerMetadataRemoval = {
  removed_at?: string | null;
  removed_by?: string | null;
  remove_reason?: string | null;
};

export function isPlayerRemovedFromTrainer(
  meta: TrainerPlayerMetadataRemoval | null | undefined,
): boolean {
  return Boolean(meta?.removed_at);
}

export function shouldShowPlayerInTrainerOverview(
  meta: TrainerPlayerMetadataRemoval | null | undefined,
): boolean {
  return !isPlayerRemovedFromTrainer(meta);
}

async function assertTrainerCanRemovePlayer(params: {
  trainerProfileId: string;
  guestPlayerId: string | null;
  profileId: string | null;
}) {
  if (params.guestPlayerId) {
    const { data, error } = await supabase
      .from('guest_players')
      .select('id')
      .eq('id', params.guestPlayerId)
      .eq('trainer_id', params.trainerProfileId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('playerNotOwnedByTrainer');
    return;
  }

  if (params.profileId) {
    const visible = await isTrainerRegisteredPlayerVisible(params.trainerProfileId, params.profileId);
    if (!visible) throw new Error('playerNotVisibleToTrainer');
    return;
  }

  throw new Error('invalidPlayerKey');
}

/** Soft-remove: sets academy_player_metadata.removed_at for trainer scope only. Never deletes global rows. */
export async function removePlayerFromTrainer(params: {
  trainerProfileId: string;
  guestPlayerId: string | null;
  profileId: string | null;
  removedByProfileId?: string | null;
  removeReason?: string | null;
}) {
  if (!params.guestPlayerId && !params.profileId) {
    throw new Error('invalidPlayerKey');
  }

  await assertTrainerCanRemovePlayer(params);

  const removedAt = new Date().toISOString();
  const baseQuery = supabase
    .from('academy_player_metadata')
    .select('id, tag_ids, notes')
    .eq('trainer_profile_id', params.trainerProfileId);

  const { data: existing } = await (params.guestPlayerId
    ? baseQuery.eq('guest_player_id', params.guestPlayerId)
    : baseQuery.eq('profile_id', params.profileId!)
  ).maybeSingle();

  const removalFields = {
    removed_at: removedAt,
    removed_by: params.removedByProfileId ?? null,
    remove_reason: params.removeReason?.trim() || null,
  };

  if (existing) {
    const { error } = await supabase
      .from('academy_player_metadata')
      .update(removalFields as Record<string, unknown>)
      .eq('id', existing.id)
      .eq('trainer_profile_id', params.trainerProfileId);
    if (error) throw error;
    return { removed_at: removedAt };
  }

  const { error } = await supabase.from('academy_player_metadata').insert({
    trainer_profile_id: params.trainerProfileId,
    guest_player_id: params.guestPlayerId,
    profile_id: params.profileId,
    tag_ids: [],
    notes: null,
    ...removalFields,
  } as Record<string, unknown>);

  if (error) throw error;
  return { removed_at: removedAt };
}
