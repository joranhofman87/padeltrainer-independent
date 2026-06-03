import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DEFAULT_PLAYER_TAG_COLOR,
  addTagIdToSelection,
  buildTagOwnerInsert,
  getOwnerColumn,
  getOwnerId,
  isPostgresUniqueViolation,
  findTagByName,
  normalizeTagName,
  type PlayerKey,
  type PlayerTagRow,
  type TagOwnerScope,
} from '@/lib/playerTags';

export async function createOwnerPlayerTag(
  client: SupabaseClient,
  scope: TagOwnerScope,
  name: string,
  color: string = DEFAULT_PLAYER_TAG_COLOR,
): Promise<{ tag: PlayerTagRow | null; error: string | null; isDuplicate: boolean }> {
  const trimmed = normalizeTagName(name);
  if (!trimmed) {
    return { tag: null, error: 'Tag name is required', isDuplicate: false };
  }

  const { data, error } = await client
    .from('academy_player_tags')
    .insert({ ...buildTagOwnerInsert(scope), name: trimmed, color } as Record<string, unknown>)
    .select('id, name, color, academy_profile_id, trainer_profile_id')
    .single();

  if (error) {
    if (isPostgresUniqueViolation(error)) {
      return { tag: null, error: null, isDuplicate: true };
    }
    return { tag: null, error: error.message, isDuplicate: false };
  }

  return { tag: data as PlayerTagRow, error: null, isDuplicate: false };
}

export async function persistPlayerTagIds(
  client: SupabaseClient,
  scope: TagOwnerScope,
  playerKey: PlayerKey,
  tagIds: string[],
): Promise<{ error: string | null }> {
  if (!playerKey.guest_player_id && !playerKey.profile_id) {
    return { error: 'Invalid player' };
  }

  const ownerCol = getOwnerColumn(scope);
  const ownerId = getOwnerId(scope);

  const baseQuery = client
    .from('academy_player_metadata')
    .select('id')
    .eq(ownerCol, ownerId);

  const { data: existing } = await (playerKey.guest_player_id
    ? baseQuery.eq('guest_player_id', playerKey.guest_player_id)
    : baseQuery.eq('profile_id', playerKey.profile_id!)
  ).maybeSingle();

  if (existing) {
    const { error } = await client
      .from('academy_player_metadata')
      .update({ tag_ids: tagIds })
      .eq('id', existing.id);
    return { error: error?.message ?? null };
  }

  const { error } = await client.from('academy_player_metadata').insert({
    ...buildTagOwnerInsert(scope),
    guest_player_id: playerKey.guest_player_id,
    profile_id: playerKey.profile_id,
    tag_ids: tagIds,
  } as Record<string, unknown>);

  return { error: error?.message ?? null };
}

export async function assignExistingTagToPlayer(
  client: SupabaseClient,
  scope: TagOwnerScope,
  playerKey: PlayerKey,
  tagId: string,
  currentTagIds: string[],
): Promise<{ tagIds: string[]; error: string | null }> {
  const next = addTagIdToSelection(currentTagIds, tagId);
  const { error } = await persistPlayerTagIds(client, scope, playerKey, next);
  return { tagIds: next, error };
}

export async function removeTagFromPlayer(
  client: SupabaseClient,
  scope: TagOwnerScope,
  playerKey: PlayerKey,
  tagId: string,
  currentTagIds: string[],
): Promise<{ tagIds: string[]; error: string | null }> {
  const next = currentTagIds.filter((id) => id !== tagId);
  const { error } = await persistPlayerTagIds(client, scope, playerKey, next);
  return { tagIds: next, error };
}

export async function createTagAndAssignToPlayer(
  client: SupabaseClient,
  scope: TagOwnerScope,
  playerKey: PlayerKey,
  name: string,
  currentTagIds: string[],
  catalogTags: PlayerTagRow[],
): Promise<{
  tag: PlayerTagRow | null;
  tagIds: string[];
  catalogTags: PlayerTagRow[];
  error: string | null;
  isDuplicate: boolean;
}> {
  const existing = findTagByName(catalogTags, name);
  if (existing) {
    const result = await assignExistingTagToPlayer(client, scope, playerKey, existing.id, currentTagIds);
    return {
      tag: existing,
      tagIds: result.tagIds,
      catalogTags,
      error: result.error,
      isDuplicate: false,
    };
  }

  const created = await createOwnerPlayerTag(client, scope, name);
  if (created.isDuplicate) {
    return { tag: null, tagIds: currentTagIds, catalogTags, error: null, isDuplicate: true };
  }
  if (created.error || !created.tag) {
    return {
      tag: null,
      tagIds: currentTagIds,
      catalogTags,
      error: created.error ?? 'Failed to create tag',
      isDuplicate: false,
    };
  }

  const assignResult = await assignExistingTagToPlayer(
    client,
    scope,
    playerKey,
    created.tag.id,
    currentTagIds,
  );

  return {
    tag: created.tag,
    tagIds: assignResult.tagIds,
    catalogTags: [...catalogTags, created.tag].sort((a, b) => a.name.localeCompare(b.name)),
    error: assignResult.error,
    isDuplicate: false,
  };
}
