// Bulk edits for the academy players table. Every action writes the academy-scoped
// academy_player_metadata row (keyed by academy + guest_player_id|profile_id), reusing
// the same store the per-player tag/note editors use. Delete is the existing SOFT
// remove-from-roster (reversible).
//
// Resilience: each player is processed independently — one failure never aborts the rest.
// Every action returns a BulkResult so the UI can report partial success with the real
// per-player reason ("8 done, 2 failed: <reason>") instead of one generic error.
import { supabase } from '@/integrations/supabase/client';
import { removePlayerFromAcademy } from './academyPlayerRemoval';

export type BulkPlayerKey = { guest_player_id: string | null; profile_id: string | null };
export interface BulkFailure<T> { item: T; reason: string; }
export interface BulkResult<T> { succeeded: number; failed: BulkFailure<T>[]; }

interface ExistingMeta {
  id: string;
  guest_player_id: string | null;
  profile_id: string | null;
  tag_ids: string[] | null;
  notes: string | null;
}

const keyOf = (p: BulkPlayerKey) => (p.guest_player_id ? `g:${p.guest_player_id}` : `p:${p.profile_id}`);

const reasonOf = (e: unknown): string => {
  const err = e as { message?: string; details?: string; hint?: string };
  return [err?.message, err?.details].filter(Boolean).join(' — ') || String(e);
};

async function fetchExisting(academyId: string, players: BulkPlayerKey[]): Promise<Map<string, ExistingMeta>> {
  const guestIds = players.map(p => p.guest_player_id).filter((x): x is string => !!x);
  const profileIds = players.map(p => p.profile_id).filter((x): x is string => !!x);
  const map = new Map<string, ExistingMeta>();
  const collect = (rows: ExistingMeta[] | null) => rows?.forEach(r => map.set(keyOf(r), r));
  const cols = 'id, guest_player_id, profile_id, tag_ids, notes';
  if (guestIds.length > 0) {
    const { data } = await supabase.from('academy_player_metadata').select(cols)
      .eq('academy_profile_id', academyId).in('guest_player_id', guestIds);
    collect(data as ExistingMeta[] | null);
  }
  if (profileIds.length > 0) {
    const { data } = await supabase.from('academy_player_metadata').select(cols)
      .eq('academy_profile_id', academyId).in('profile_id', profileIds);
    collect(data as ExistingMeta[] | null);
  }
  return map;
}

/** Apply a metadata patch (computed per existing row) to every selected player, resiliently. */
async function applyMetadata<T extends BulkPlayerKey>(
  academyId: string,
  players: T[],
  build: (existing: ExistingMeta | null) => Record<string, unknown>,
): Promise<BulkResult<T>> {
  if (players.length === 0) return { succeeded: 0, failed: [] };
  const existing = await fetchExisting(academyId, players);
  let succeeded = 0;
  const failed: BulkFailure<T>[] = [];
  for (const p of players) {
    try {
      const ex = existing.get(keyOf(p)) ?? null;
      const patch = build(ex);
      if (ex) {
        const { error } = await supabase.from('academy_player_metadata').update(patch).eq('id', ex.id);
        if (error) throw error;
      } else {
        // CHECK constraint: exactly one of guest_player_id / profile_id. Prefer the guest id.
        const { error } = await supabase.from('academy_player_metadata').insert({
          academy_profile_id: academyId,
          guest_player_id: p.guest_player_id,
          profile_id: p.guest_player_id ? null : p.profile_id,
          ...patch,
        });
        if (error) throw error;
      }
      succeeded++;
    } catch (e) {
      failed.push({ item: p, reason: reasonOf(e) });
    }
  }
  return { succeeded, failed };
}

/** Add a tag to every selected player (append, de-duplicated). */
export const bulkAddTag = <T extends BulkPlayerKey>(academyId: string, players: T[], tagId: string) =>
  applyMetadata(academyId, players, ex => ({ tag_ids: [...new Set([...(ex?.tag_ids ?? []), tagId])] }));

/** Append a note line to every selected player (preserves any existing note). */
export const bulkAddNote = <T extends BulkPlayerKey>(academyId: string, players: T[], note: string) =>
  applyMetadata(academyId, players, ex => ({
    notes: [ex?.notes?.trim(), note.trim()].filter(Boolean).join('\n') || null,
  }));

/** Set the academy's preferred location for every selected player. */
export const bulkSetLocation = <T extends BulkPlayerKey>(academyId: string, players: T[], locationId: string) =>
  applyMetadata(academyId, players, () => ({ preferred_location_id: locationId }));

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
