// Bulk edits for the academy players table. Every action writes the academy-scoped
// academy_player_metadata row (keyed by academy + guest_player_id|profile_id), reusing
// the same store the per-player tag/note editors use. Delete is the existing SOFT
// remove-from-roster (reversible).
//
// Resilience: each player is processed independently — one failure never aborts the rest.
// Every action returns a BulkResult so the UI can report partial success with the real
// per-player reason ("8 done, 2 failed: <reason>") instead of one generic error.
import { removePlayerFromAcademy } from './academyPlayerRemoval';
import { OverlayWriteDisabledError } from '@/lib/overlayWriteContainment';

export type BulkPlayerKey = { guest_player_id: string | null; profile_id: string | null };
export interface BulkFailure<T> { item: T; reason: string; }
export interface BulkResult<T> { succeeded: number; failed: BulkFailure<T>[]; }

const reasonOf = (e: unknown): string => {
  const err = e as { message?: string; details?: string; hint?: string };
  return [err?.message, err?.details].filter(Boolean).join(' — ') || String(e);
};

/**
 * ABC-16 H0 — every bulk metadata action is contained.
 *
 * The BulkResult contract is preserved exactly: each selected player is reported as FAILED
 * with the plain-language containment reason, so the caller's "8 done, 2 failed: <reason>"
 * summary stays truthful. Nothing is counted as succeeded and no request is sent.
 */
function refuseBulk<T extends BulkPlayerKey>(players: T[]): BulkResult<T> {
  const reason = reasonOf(new OverlayWriteDisabledError('tags'));
  return { succeeded: 0, failed: players.map((item) => ({ item, reason })) };
}

/** Add a tag to every selected player. ABC-16 H0: temporarily read-only. */
export const bulkAddTag = async <T extends BulkPlayerKey>(_academyId: string, players: T[], _tagId: string):
  Promise<BulkResult<T>> => refuseBulk(players);

/** Append a note line to every selected player. ABC-16 H0: temporarily read-only. */
export const bulkAddNote = async <T extends BulkPlayerKey>(_academyId: string, players: T[], _note: string):
  Promise<BulkResult<T>> => refuseBulk(players);

/** Set the academy's preferred location for every selected player. ABC-16 H0: temporarily read-only. */
export const bulkSetLocation = async <T extends BulkPlayerKey>(_academyId: string, players: T[], _locationId: string):
  Promise<BulkResult<T>> => refuseBulk(players);

/** Soft-remove every selected player from the academy roster (reversible), resiliently. */
export async function bulkRemovePlayers<T extends BulkPlayerKey>(
  academyId: string,
  players: T[],
  removedByProfileId: string | null,
): Promise<BulkResult<T>> {
  let succeeded = 0;
  const failed: BulkFailure<T>[] = [];
  for (const p of players) {
    try {
      await removePlayerFromAcademy({
        academyProfileId: academyId,
        guestPlayerId: p.guest_player_id,
        profileId: p.profile_id,
        removedByProfileId,
      });
      succeeded++;
    } catch (e) {
      failed.push({ item: p, reason: reasonOf(e) });
    }
  }
  return { succeeded, failed };
}
