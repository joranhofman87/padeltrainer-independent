// Bulk edits for the academy players table. Every action writes the academy-scoped
// academy_player_metadata row (keyed by academy + guest_player_id|profile_id), reusing
// the same store the per-player tag/note editors use. Delete is the existing SOFT
// remove-from-roster (reversible). Mutations are batched: one read of existing rows,
// one insert for players without metadata, individual updates for those that have it.
import { supabase } from '@/integrations/supabase/client';
import { removePlayerFromAcademy } from './academyPlayerRemoval';

export type BulkPlayerKey = { guest_player_id: string | null; profile_id: string | null };

interface ExistingMeta {
  id: string;
  guest_player_id: string | null;
  profile_id: string | null;
  tag_ids: string[] | null;
  notes: string | null;
}

const keyOf = (p: { guest_player_id: string | null; profile_id: string | null }) =>
  p.guest_player_id ? `g:${p.guest_player_id}` : `p:${p.profile_id}`;

async function fetchExisting(academyId: string, players: BulkPlayerKey[]): Promise<Map<string, ExistingMeta>> {
  const guestIds = players.map(p => p.guest_player_id).filter((x): x is string => !!x);
  const profileIds = players.map(p => p.profile_id).filter((x): x is string => !!x);
  const map = new Map<string, ExistingMeta>();
  const collect = (rows: ExistingMeta[] | null) =>
    rows?.forEach(r => map.set(keyOf(r), r));
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

/** Apply a metadata patch (computed per existing row) to every selected player. */
async function applyMetadata(
  academyId: string,
  players: BulkPlayerKey[],
  build: (existing: ExistingMeta | null) => Record<string, unknown>,
): Promise<void> {
  if (players.length === 0) return;
  const existing = await fetchExisting(academyId, players);
  const inserts: Record<string, unknown>[] = [];
  for (const p of players) {
    const ex = existing.get(keyOf(p)) ?? null;
    const patch = build(ex);
    if (ex) {
      const { error } = await supabase.from('academy_player_metadata').update(patch).eq('id', ex.id);
      if (error) throw error;
    } else {
      // CHECK constraint: exactly one of guest_player_id / profile_id. Prefer the guest id.
      inserts.push({
        academy_profile_id: academyId,
        guest_player_id: p.guest_player_id,
        profile_id: p.guest_player_id ? null : p.profile_id,
        ...patch,
      });
    }
  }
  if (inserts.length > 0) {
    const { error } = await supabase.from('academy_player_metadata').insert(inserts);
    if (error) throw error;
  }
}

/** Add a tag to every selected player (append, de-duplicated). */
export const bulkAddTag = (academyId: string, players: BulkPlayerKey[], tagId: string) =>
  applyMetadata(academyId, players, ex => ({ tag_ids: [...new Set([...(ex?.tag_ids ?? []), tagId])] }));

/** Append a note line to every selected player (preserves any existing note). */
export const bulkAddNote = (academyId: string, players: BulkPlayerKey[], note: string) =>
  applyMetadata(academyId, players, ex => ({
    notes: [ex?.notes?.trim(), note.trim()].filter(Boolean).join('\n') || null,
  }));

/** Set the academy's preferred location for every selected player. */
export const bulkSetLocation = (academyId: string, players: BulkPlayerKey[], locationId: string) =>
  applyMetadata(academyId, players, () => ({ preferred_location_id: locationId }));

/** Soft-remove every selected player from the academy roster (reversible). */
export async function bulkRemovePlayers(
  academyId: string,
  players: BulkPlayerKey[],
  removedByProfileId: string | null,
): Promise<void> {
  for (const p of players) {
    await removePlayerFromAcademy({
      academyProfileId: academyId,
      guestPlayerId: p.guest_player_id,
      profileId: p.profile_id,
      removedByProfileId,
    });
  }
}
