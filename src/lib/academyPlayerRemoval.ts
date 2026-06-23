import { supabase } from '@/lib/supabaseClient';

export type AcademyPlayerRemovalKey = {
  guestPlayerId: string | null;
  profileId: string | null;
};

export type AcademyPlayerMetadataRemoval = {
  removed_at: string | null;
  removed_by?: string | null;
  remove_reason?: string | null;
};

export function isPlayerRemovedFromAcademy(
  meta: AcademyPlayerMetadataRemoval | null | undefined,
): boolean {
  return Boolean(meta?.removed_at);
}

export function shouldShowPlayerInAcademyOverview(
  meta: AcademyPlayerMetadataRemoval | null | undefined,
): boolean {
  return !isPlayerRemovedFromAcademy(meta);
}

/** Soft-remove: sets academy_player_metadata.removed_at only. Never deletes global player rows. */
export async function removePlayerFromAcademy(params: {
  academyProfileId: string;
  guestPlayerId: string | null;
  profileId: string | null;
  removedByProfileId?: string | null;
  removeReason?: string | null;
}) {
  if (!params.guestPlayerId && !params.profileId) {
    throw new Error('invalidPlayerKey');
  }

  const removedAt = new Date().toISOString();
  const removalFields = {
    removed_at: removedAt,
    removed_by: params.removedByProfileId ?? null,
    remove_reason: params.removeReason?.trim() || null,
  };

  // A linked guest surfaces in the players overview via its GUEST id, and the overview
  // hides the linked registered profile precisely because a guest points at it. So we must
  // mark removed_at on EVERY identity the player has — guest AND linked profile — each in
  // its own row (the table's CHECK allows only one id per row). Removing just the guest
  // would un-hide the profile and the player would reappear as a registered player.
  const targets: Array<{ col: 'guest_player_id' | 'profile_id'; val: string }> = [];
  if (params.guestPlayerId) targets.push({ col: 'guest_player_id', val: params.guestPlayerId });
  if (params.profileId) targets.push({ col: 'profile_id', val: params.profileId });

  for (const target of targets) {
    const { data: existing } = await supabase
      .from('academy_player_metadata')
      .select('id')
      .eq('academy_profile_id', params.academyProfileId)
      .eq(target.col, target.val)
      .maybeSingle();

    if (existing) {
      const { error } = await supabase
        .from('academy_player_metadata')
        .update(removalFields as any)
        .eq('id', existing.id)
        .eq('academy_profile_id', params.academyProfileId);
      if (error) throw error;
    } else {
      const { error } = await supabase.from('academy_player_metadata').insert({
        academy_profile_id: params.academyProfileId,
        guest_player_id: target.col === 'guest_player_id' ? target.val : null,
        profile_id: target.col === 'profile_id' ? target.val : null,
        tag_ids: [],
        notes: null,
        ...removalFields,
      } as any);
      if (error) throw error;
    }
  }

  return { removed_at: removedAt };
}
