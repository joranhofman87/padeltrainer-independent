import { supabase } from '@/lib/supabaseClient';
import { isTrainerRegisteredPlayerVisible } from '@/lib/invoiceSelectablePlayers';
import { refuseOverlayWrite } from '@/lib/overlayWriteContainment';

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
}): Promise<never> {
  if (!params.guestPlayerId && !params.profileId) {
    throw new Error('invalidPlayerKey');
  }

  // The ownership assertion is kept and still runs FIRST, so a trainer acting on a player
  // they do not own keeps getting that specific answer rather than the containment message.
  await assertTrainerCanRemovePlayer(params);

  // ABC-16 H0: no client writer. The trainer arm creates the same caller-authored
  // `academy_player_metadata` row as the academy arm — its policy proves only that the
  // caller owns the ROW, never that the subject trains with them. Existing removals still
  // hide their players; no row was changed by H0.
  refuseOverlayWrite('removal');
}
