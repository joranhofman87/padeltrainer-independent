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
  const baseQuery = supabase
    .from('academy_player_metadata')
    .select('id, tag_ids, notes')
    .eq('academy_profile_id', params.academyProfileId);

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
      .update(removalFields as any)
      .eq('id', existing.id)
      .eq('academy_profile_id', params.academyProfileId);
    if (error) throw error;
    return { removed_at: removedAt };
  }

  const { error } = await supabase.from('academy_player_metadata').insert({
    academy_profile_id: params.academyProfileId,
    // CHECK constraint requires exactly one of guest/profile — prefer the guest id.
    guest_player_id: params.guestPlayerId,
    profile_id: params.guestPlayerId ? null : params.profileId,
    tag_ids: [],
    notes: null,
    ...removalFields,
  } as any);

  if (error) throw error;
  return { removed_at: removedAt };
}
