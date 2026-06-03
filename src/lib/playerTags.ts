import type { PlayerMetadata } from '@/components/players/playerTagColors';

export type PlayerTagRow = {
  id: string;
  name: string;
  color: string;
  academy_profile_id?: string | null;
  trainer_profile_id?: string | null;
};

export type PlayerKey = {
  guest_player_id: string | null;
  profile_id: string | null;
};

export type TagOwnerScope =
  | { kind: 'academy'; academyProfileId: string }
  | { kind: 'trainer'; trainerProfileId: string };

export const DEFAULT_PLAYER_TAG_COLOR = 'slate';

export function normalizeTagName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

export function tagNamesEqual(a: string, b: string): boolean {
  return normalizeTagName(a).toLowerCase() === normalizeTagName(b).toLowerCase();
}

/** True when another tag in the academy/trainer catalog already uses this name. */
export function isDuplicateTagName(tags: PlayerTagRow[], name: string): boolean {
  const normalized = normalizeTagName(name);
  if (!normalized) return false;
  return tags.some((tag) => tagNamesEqual(tag.name, normalized));
}

export function findTagByName(tags: PlayerTagRow[], name: string): PlayerTagRow | undefined {
  const normalized = normalizeTagName(name);
  if (!normalized) return undefined;
  return tags.find((tag) => tagNamesEqual(tag.name, normalized));
}

export function filterTagsByQuery(tags: PlayerTagRow[], query: string): PlayerTagRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...tags].sort((a, b) => a.name.localeCompare(b.name));
  return tags
    .filter((tag) => tag.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getUnassignedTags(
  tags: PlayerTagRow[],
  selectedTagIds: string[],
  query: string,
): PlayerTagRow[] {
  const assigned = new Set(selectedTagIds);
  return filterTagsByQuery(
    tags.filter((tag) => !assigned.has(tag.id)),
    query,
  );
}

/** Whether the picker should offer "Create …" for the current search text. */
export function canOfferCreateTag(
  tags: PlayerTagRow[],
  query: string,
): boolean {
  const name = normalizeTagName(query);
  if (!name) return false;
  if (isDuplicateTagName(tags, name)) return false;
  if (findTagByName(tags, name)) return false;
  return true;
}

export function addTagIdToSelection(selectedTagIds: string[], tagId: string): string[] {
  if (selectedTagIds.includes(tagId)) return selectedTagIds;
  return [...selectedTagIds, tagId];
}

export function removeTagIdFromSelection(selectedTagIds: string[], tagId: string): string[] {
  return selectedTagIds.filter((id) => id !== tagId);
}

export function appendTagToCatalog(tags: PlayerTagRow[], tag: PlayerTagRow): PlayerTagRow[] {
  if (tags.some((t) => t.id === tag.id)) return tags;
  return [...tags, tag].sort((a, b) => a.name.localeCompare(b.name));
}

export function getOwnerColumn(scope: TagOwnerScope): 'academy_profile_id' | 'trainer_profile_id' {
  return scope.kind === 'academy' ? 'academy_profile_id' : 'trainer_profile_id';
}

export function getOwnerId(scope: TagOwnerScope): string {
  return scope.kind === 'academy' ? scope.academyProfileId : scope.trainerProfileId;
}

export function buildTagOwnerInsert(scope: TagOwnerScope): Record<string, string> {
  const col = getOwnerColumn(scope);
  return { [col]: getOwnerId(scope) };
}

export function playerKeysMatch(a: PlayerKey, b: PlayerKey): boolean {
  if (a.guest_player_id && b.guest_player_id) {
    return a.guest_player_id === b.guest_player_id;
  }
  if (a.profile_id && b.profile_id) {
    return a.profile_id === b.profile_id;
  }
  return false;
}

/** Update metadata list for one player without refetching (table view). */
export function upsertMetadataTagIds(
  metadata: PlayerMetadata[],
  playerKey: PlayerKey,
  tagIds: string[],
): PlayerMetadata[] {
  const idx = metadata.findIndex(
    (m) =>
      (playerKey.guest_player_id && m.guest_player_id === playerKey.guest_player_id) ||
      (playerKey.profile_id && m.profile_id === playerKey.profile_id),
  );

  if (idx >= 0) {
    return metadata.map((m, i) => (i === idx ? { ...m, tag_ids: tagIds } : m));
  }

  return [
    ...metadata,
    {
      id: `local-${playerKey.guest_player_id ?? playerKey.profile_id}`,
      guest_player_id: playerKey.guest_player_id,
      profile_id: playerKey.profile_id,
      notes: null,
      tag_ids: tagIds,
    },
  ];
}

export function isPostgresUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: string }).code === '23505'
  );
}
