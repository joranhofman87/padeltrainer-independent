import { describe, it, expect, vi } from 'vitest';
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

// ── ABC-16 H0 ──────────────────────────────────────────────────────────────────────────────
// Assigning a tag writes `academy_player_metadata.tag_ids` — and, when no row existed, CREATES
// the row that three authorization predicates accepted as proof of the academy↔player
// relationship. Assignment is contained until an H1 command derives the subject from canonical
// membership. These cases used to assert the write; they now assert its absence.
//
// This module reports failures by RETURNING an error, so the containment does too: a thrown
// error would bypass every caller's error handling and surface as an unhandled rejection.

describe('assignExistingTagToPlayer', () => {
  it('refuses, reports a plain-language error, and writes nothing', async () => {
    const { client, metaUpdate, metaInsert } = createMockClient({
      metaSelect: () => ({ data: { id: 'meta-1' }, error: null }),
    });

    const result = await assignExistingTagToPlayer(client, scope, playerKey, 'tag-2', ['tag-1']);
    expect(result.error).toMatch(/read-only/i);
    expect(result.error).not.toMatch(/permission denied|row-level security|42501/i);
    expect(metaUpdate).not.toHaveBeenCalled();
    expect(metaInsert).not.toHaveBeenCalled();
  });
});

describe('persistPlayerTagIds', () => {
  it('refuses instead of inserting metadata', async () => {
    const { client, metaInsert } = createMockClient({
      metaSelect: () => ({ data: null, error: null }),
    });

    const result = await persistPlayerTagIds(client, scope, playerKey, ['tag-1']);
    expect(result.error).toMatch(/read-only/i);
    expect(metaInsert).not.toHaveBeenCalled();
  });

  it('an invalid player key is still reported as such, not as the containment', async () => {
    const { client } = createMockClient({});
    const result = await persistPlayerTagIds(client, scope, { guest_player_id: null, profile_id: null }, ['t']);
    expect(result.error).toBe('Invalid player');
  });
});

describe('createTagAndAssignToPlayer', () => {
  const catalog: PlayerTagRow[] = [{ id: 'tag-1', name: 'VIP', color: 'blue' }];

  it('resolves an existing tag by name but cannot assign it', async () => {
    const { client } = createMockClient({
      metaSelect: () => ({ data: { id: 'meta-1' }, error: null }),
    });

    const result = await createTagAndAssignToPlayer(client, scope, playerKey, 'vip', [], catalog);
    // The name match still resolves — the catalogue is readable and that lookup is harmless.
    expect(result.tag?.id).toBe('tag-1');
    expect(result.error).toMatch(/read-only/i);
  });

  it('refuses a NEW tag WITHOUT creating the definition first', async () => {
    // Tag definitions live in a different table with no player subject, so creating one still
    // works. That makes ordering load-bearing: refusing after the create would leave an orphan
    // tag in the academy's catalogue every time someone tried, from an action that then failed.
    const tagInsert = vi.fn(() => ({
      data: { id: 'tag-new', name: 'Lead', color: 'slate', academy_profile_id: 'academy-1' },
      error: null,
    }));
    const { client } = createMockClient({ tagInsert, metaSelect: () => ({ data: { id: 'meta-1' }, error: null }) });

    const result = await createTagAndAssignToPlayer(client, scope, playerKey, 'Lead', [], catalog);

    expect(result.error).toMatch(/read-only/i);
    expect(result.tag).toBeNull();
    expect(result.tagIds).toEqual([]);
    expect(result.catalogTags).toEqual(catalog);   // catalogue unchanged
    expect(tagInsert).not.toHaveBeenCalled();      // and nothing was created
  });
});
