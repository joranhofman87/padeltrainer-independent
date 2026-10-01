import { refuseOverlayWrite } from '@/lib/overlayWriteContainment';

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

/**
 * Soft-remove: sets academy_player_metadata.removed_at only. Never deletes global player rows.
 *
 * ABC-16 H0: temporarily has no client writer. Soft removal wrote — and for a player with no
 * prior overlay row, CREATED — exactly the `academy_player_metadata` row that three
 * authorization predicates then accepted as proof of the academy↔player relationship, for a
 * caller-chosen subject. It is the clearest instance of the defect, so it closes with the
 * rest; see `src/lib/overlayWriteContainment.ts`.
 *
 * Existing removals are unaffected and still hide their players: `removed_at` is read by
 * `get_players_overview` exactly as before, and no row was changed by H0.
 */
export async function removePlayerFromAcademy(params: {
  academyProfileId: string;
  guestPlayerId: string | null;
  profileId: string | null;
  removedByProfileId?: string | null;
  removeReason?: string | null;
}): Promise<never> {
  // Key validation first: an invalid call should still read as invalid, not as contained.
  if (!params.guestPlayerId && !params.profileId) {
    throw new Error('invalidPlayerKey');
  }
  refuseOverlayWrite('removal');
}
