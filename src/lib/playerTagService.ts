import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DEFAULT_PLAYER_TAG_COLOR,
  addTagIdToSelection,
  buildTagOwnerInsert,
  isPostgresUniqueViolation,
  findTagByName,
  normalizeTagName,
  type PlayerKey,
  type PlayerTagRow,
  type TagOwnerScope,
} from '@/lib/playerTags';
import { OverlayWriteDisabledError } from '@/lib/overlayWriteContainment';

/**
 * ABC-16 H0: assigning a tag to a player writes `academy_player_metadata.tag_ids`, and that
 * row was accepted as proof of the academy↔player relationship. Assignment is therefore
 * contained until an H1 command derives the subject from canonical membership.
 *
 * This module reports failures by RETURNING an error rather than throwing, so the
 * containment follows that contract instead of throwing past every caller. The message is
 * the plain-language one from the shared error, never a Postgres permission string.
 *
 * Tag DEFINITIONS (`academy_player_tags`) are a different table with no player subject and
 * no authority role, so creating and listing tags is deliberately still allowed.
 */
const TAG_ASSIGNMENT_DISABLED = new OverlayWriteDisabledError('tags').message;

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

/** ABC-16 H0 — the single choke point for tag assignment; no client writer exists. */
export async function persistPlayerTagIds(
  _client: SupabaseClient,
  _scope: TagOwnerScope,
  playerKey: PlayerKey,
  _tagIds: string[],
): Promise<{ error: string | null }> {
  if (!playerKey.guest_player_id && !playerKey.profile_id) {
    return { error: 'Invalid player' };
  }
  return { error: TAG_ASSIGNMENT_DISABLED };
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

  // ABC-16 H0: refuse BEFORE creating the definition. Creating a tag still works (a tag
  // definition has no player subject), so running the old create-then-assign flow would
  // leave an orphan tag in the academy's catalogue on every attempt — a write the user
  // never asked for, produced by an action that then failed.
  return {
    tag: null,
    tagIds: currentTagIds,
    catalogTags,
    error: TAG_ASSIGNMENT_DISABLED,
    isDuplicate: false,
  };
}
