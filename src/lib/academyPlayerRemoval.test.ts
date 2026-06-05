import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isPlayerRemovedFromAcademy,
  shouldShowPlayerInAcademyOverview,
  removePlayerFromAcademy,
} from './academyPlayerRemoval';

const ACADEMY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACADEMY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GUEST_ID = 'gggggggg-gggg-4ggg-8ggg-gggggggggggg';
const PROFILE_ID = 'pppppppp-pppp-4ppp-8ppp-pppppppppppp';
const META_ID = 'mmmmmmmm-mmmm-4mmm-8mmm-mmmmmmmmmmmm';
const MANAGER_ID = 'uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu';

const updateMock = vi.fn();
const insertMock = vi.fn();
const eqCalls: Array<[string, ...unknown[]]> = [];
const fromTables: string[] = [];

function createChain(table: string) {
  fromTables.push(table);
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: (...args: unknown[]) => {
      eqCalls.push([table, ...args]);
      return chain;
    },
    update: (payload: unknown) => {
      updateMock(table, payload);
      return {
        eq: (...args: unknown[]) => {
          eqCalls.push([table, ...args]);
          return {
            eq: (...innerArgs: unknown[]) => {
              eqCalls.push([table, ...innerArgs]);
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
    insert: (payload: unknown) => {
      insertMock(table, payload);
      return Promise.resolve({ error: null });
    },
    maybeSingle: () => maybeSingleMock(table),
  };
  return chain;
}

const maybeSingleMock = vi.fn();

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: (table: string) => createChain(table),
  },
}));

describe('academyPlayerRemoval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eqCalls.length = 0;
    fromTables.length = 0;
    maybeSingleMock.mockResolvedValue({ data: null, error: null });
  });

  it('detects removed metadata', () => {
    expect(isPlayerRemovedFromAcademy({ removed_at: '2026-01-01T00:00:00Z' })).toBe(true);
    expect(isPlayerRemovedFromAcademy({ removed_at: null })).toBe(false);
    expect(shouldShowPlayerInAcademyOverview({ removed_at: '2026-01-01T00:00:00Z' })).toBe(false);
    expect(shouldShowPlayerInAcademyOverview(null)).toBe(true);
  });

  it('inserts metadata with removed_at for guest without existing row', async () => {
    await removePlayerFromAcademy({
      academyProfileId: ACADEMY_A,
      guestPlayerId: GUEST_ID,
      profileId: null,
      removedByProfileId: MANAGER_ID,
    });

    expect(fromTables).not.toContain('guest_players');
    expect(fromTables).not.toContain('profiles');
    expect(insertMock).toHaveBeenCalledWith(
      'academy_player_metadata',
      expect.objectContaining({
        academy_profile_id: ACADEMY_A,
        guest_player_id: GUEST_ID,
        profile_id: null,
        removed_by: MANAGER_ID,
        removed_at: expect.any(String),
      }),
    );
  });

  it('updates existing metadata with removed_at for registered player', async () => {
    maybeSingleMock.mockResolvedValue({
      data: { id: META_ID, tag_ids: ['tag-1'], notes: 'Keep notes' },
      error: null,
    });

    await removePlayerFromAcademy({
      academyProfileId: ACADEMY_A,
      guestPlayerId: null,
      profileId: PROFILE_ID,
      removedByProfileId: MANAGER_ID,
    });

    expect(updateMock).toHaveBeenCalledWith(
      'academy_player_metadata',
      expect.objectContaining({
        removed_at: expect.any(String),
        removed_by: MANAGER_ID,
      }),
    );
    expect(insertMock).not.toHaveBeenCalled();
    expect(eqCalls).toContainEqual(['academy_player_metadata', 'id', META_ID]);
    expect(eqCalls).toContainEqual(['academy_player_metadata', 'academy_profile_id', ACADEMY_A]);
  });

  it('scopes removal to the given academy profile id', async () => {
    maybeSingleMock.mockResolvedValue({
      data: { id: META_ID, tag_ids: [], notes: null },
      error: null,
    });

    await removePlayerFromAcademy({
      academyProfileId: ACADEMY_A,
      guestPlayerId: GUEST_ID,
      profileId: null,
    });

    expect(eqCalls).toContainEqual(['academy_player_metadata', 'academy_profile_id', ACADEMY_A]);
    expect(eqCalls).not.toContainEqual(['academy_player_metadata', 'academy_profile_id', ACADEMY_B]);
  });

  it('rejects invalid player key', async () => {
    await expect(
      removePlayerFromAcademy({
        academyProfileId: ACADEMY_A,
        guestPlayerId: null,
        profileId: null,
      }),
    ).rejects.toThrow('invalidPlayerKey');
  });
});
