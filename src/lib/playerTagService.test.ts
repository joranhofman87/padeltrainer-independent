import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  assignExistingTagToPlayer,
  createOwnerPlayerTag,
  createTagAndAssignToPlayer,
  persistPlayerTagIds,
} from './playerTagService';
import type { PlayerTagRow } from './playerTags';

type Row = Record<string, unknown>;

function createMockClient(handlers: {
  tagInsert?: () => { data: Row | null; error: { message: string; code?: string } | null };
  metaSelect?: () => { data: Row | null; error: null };
  metaUpdate?: () => { error: null };
  metaInsert?: () => { error: null };
}) {
  const tagInsert = vi.fn(() => handlers.tagInsert?.() ?? { data: null, error: null });
  const metaSelect = vi.fn(() => handlers.metaSelect?.() ?? { data: null, error: null });
  const metaUpdate = vi.fn(() => handlers.metaUpdate?.() ?? { error: null });
  const metaInsert = vi.fn(() => handlers.metaInsert?.() ?? { error: null });

  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    maybeSingle: metaSelect,
    single: tagInsert,
    insert: vi.fn((payload: Row) => {
      if ('name' in payload && 'color' in payload) return { select: () => ({ single: tagInsert }) };
      return { error: metaInsert().error };
    }),
    update: vi.fn(() => ({ eq: () => metaUpdate() })),
  };

  return {
    client: {
      from: vi.fn((table: string) => {
        if (table === 'academy_player_tags') return chain;
        if (table === 'academy_player_metadata') return chain;
        throw new Error(`unexpected table ${table}`);
      }),
    } as any,
    tagInsert,
    metaUpdate,
    metaInsert,
  };
}

const scope = { kind: 'academy' as const, academyProfileId: 'academy-1' };
const playerKey = { guest_player_id: 'guest-1', profile_id: null };

describe('createOwnerPlayerTag', () => {
  it('creates a tag row', async () => {
    const { client } = createMockClient({
      tagInsert: () => ({
        data: {
          id: 'tag-new',
          name: 'Lead',
          color: 'slate',
          academy_profile_id: 'academy-1',
          trainer_profile_id: null,
        },
        error: null,
      }),
    });

    const result = await createOwnerPlayerTag(client, scope, 'Lead');
    expect(result.tag?.name).toBe('Lead');
    expect(result.isDuplicate).toBe(false);
  });

  it('reports duplicate on unique violation', async () => {
    const { client } = createMockClient({
      tagInsert: () => ({ data: null, error: { message: 'duplicate', code: '23505' } }),
    });

    const result = await createOwnerPlayerTag(client, scope, 'VIP');
    expect(result.isDuplicate).toBe(true);
    expect(result.tag).toBeNull();
  });
});

describe('assignExistingTagToPlayer', () => {
  it('persists merged tag ids', async () => {
    const { client, metaUpdate } = createMockClient({
      metaSelect: () => ({ data: { id: 'meta-1' }, error: null }),
    });

    const result = await assignExistingTagToPlayer(client, scope, playerKey, 'tag-2', ['tag-1']);
    expect(result.tagIds).toEqual(['tag-1', 'tag-2']);
    expect(result.error).toBeNull();
    expect(metaUpdate).toHaveBeenCalled();
  });
});

describe('persistPlayerTagIds', () => {
  it('inserts metadata when none exists', async () => {
    const { client, metaInsert } = createMockClient({
      metaSelect: () => ({ data: null, error: null }),
    });

    const result = await persistPlayerTagIds(client, scope, playerKey, ['tag-1']);
    expect(result.error).toBeNull();
    expect(metaInsert).toHaveBeenCalled();
  });
});

describe('createTagAndAssignToPlayer', () => {
  const catalog: PlayerTagRow[] = [{ id: 'tag-1', name: 'VIP', color: 'blue' }];

  it('assigns existing tag when name matches', async () => {
    const { client } = createMockClient({
      metaSelect: () => ({ data: { id: 'meta-1' }, error: null }),
    });

    const result = await createTagAndAssignToPlayer(
      client,
      scope,
      playerKey,
      'vip',
      [],
      catalog,
    );
    expect(result.tag?.id).toBe('tag-1');
    expect(result.tagIds).toEqual(['tag-1']);
    expect(result.isDuplicate).toBe(false);
  });

  it('creates and assigns a new tag', async () => {
    const { client } = createMockClient({
      tagInsert: () => ({
        data: { id: 'tag-new', name: 'Lead', color: 'slate', academy_profile_id: 'academy-1' },
        error: null,
      }),
      metaSelect: () => ({ data: { id: 'meta-1' }, error: null }),
    });

    const result = await createTagAndAssignToPlayer(
      client,
      scope,
      playerKey,
      'Lead',
      [],
      catalog,
    );
    expect(result.tag?.name).toBe('Lead');
    expect(result.tagIds).toEqual(['tag-new']);
    expect(result.catalogTags.some((t) => t.id === 'tag-new')).toBe(true);
  });
});
