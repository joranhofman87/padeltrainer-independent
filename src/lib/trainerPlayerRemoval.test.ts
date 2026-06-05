import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isPlayerRemovedFromTrainer,
  shouldShowPlayerInTrainerOverview,
  removePlayerFromTrainer,
} from './trainerPlayerRemoval';

const TRAINER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TRAINER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GUEST_ID = 'gggggggg-gggg-4ggg-8ggg-gggggggggggg';
const PROFILE_ID = 'pppppppp-pppp-4ppp-8ppp-pppppppppppp';
const META_ID = 'mmmmmmmm-mmmm-4mmm-8mmm-mmmmmmmmmmmm';
const MANAGER_ID = 'uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu';

const updateMock = vi.fn();
const insertMock = vi.fn();
const eqCalls: Array<[string, ...unknown[]]> = [];
const fromTables: string[] = [];

const visibleMock = vi.fn();

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

vi.mock('@/lib/invoiceSelectablePlayers', () => ({
  isTrainerRegisteredPlayerVisible: (...args: unknown[]) => visibleMock(...args),
}));

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: (table: string) => createChain(table),
  },
}));

describe('trainerPlayerRemoval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eqCalls.length = 0;
    fromTables.length = 0;
    maybeSingleMock.mockImplementation((table: string) => {
      if (table === 'guest_players') {
        return Promise.resolve({ data: { id: GUEST_ID }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    visibleMock.mockResolvedValue(true);
  });

  it('detects removed metadata', () => {
    expect(isPlayerRemovedFromTrainer({ removed_at: '2026-01-01T00:00:00Z' })).toBe(true);
    expect(isPlayerRemovedFromTrainer({ removed_at: null })).toBe(false);
    expect(shouldShowPlayerInTrainerOverview({ removed_at: '2026-01-01T00:00:00Z' })).toBe(false);
    expect(shouldShowPlayerInTrainerOverview(null)).toBe(true);
  });

  it('inserts metadata with removed_at for guest without existing row', async () => {
    await removePlayerFromTrainer({
      trainerProfileId: TRAINER_A,
      guestPlayerId: GUEST_ID,
      profileId: null,
      removedByProfileId: MANAGER_ID,
    });

    expect(fromTables).not.toContain('profiles');
    expect(insertMock).toHaveBeenCalledWith(
      'academy_player_metadata',
      expect.objectContaining({
        trainer_profile_id: TRAINER_A,
        guest_player_id: GUEST_ID,
        profile_id: null,
        removed_by: MANAGER_ID,
        removed_at: expect.any(String),
      }),
    );
    expect(updateMock).not.toHaveBeenCalledWith('guest_players', expect.anything());
  });

  it('updates existing metadata with removed_at for registered player', async () => {
    maybeSingleMock.mockImplementation((table: string) => {
      if (table === 'academy_player_metadata') {
        return Promise.resolve({
          data: { id: META_ID, tag_ids: ['tag-1'], notes: 'Keep notes' },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    await removePlayerFromTrainer({
      trainerProfileId: TRAINER_A,
      guestPlayerId: null,
      profileId: PROFILE_ID,
      removedByProfileId: MANAGER_ID,
    });

    expect(visibleMock).toHaveBeenCalledWith(TRAINER_A, PROFILE_ID);
    expect(updateMock).toHaveBeenCalledWith(
      'academy_player_metadata',
      expect.objectContaining({
        removed_at: expect.any(String),
        removed_by: MANAGER_ID,
      }),
    );
    expect(insertMock).not.toHaveBeenCalled();
    expect(eqCalls).toContainEqual(['academy_player_metadata', 'trainer_profile_id', TRAINER_A]);
  });

  it('scopes removal to the given trainer profile id', async () => {
    maybeSingleMock.mockImplementation((table: string) => {
      if (table === 'guest_players') {
        return Promise.resolve({ data: { id: GUEST_ID }, error: null });
      }
      if (table === 'academy_player_metadata') {
        return Promise.resolve({
          data: { id: META_ID, tag_ids: [], notes: null },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    await removePlayerFromTrainer({
      trainerProfileId: TRAINER_A,
      guestPlayerId: GUEST_ID,
      profileId: null,
    });

    expect(eqCalls).toContainEqual(['academy_player_metadata', 'trainer_profile_id', TRAINER_A]);
    expect(eqCalls).not.toContainEqual(['academy_player_metadata', 'trainer_profile_id', TRAINER_B]);
    expect(eqCalls).toContainEqual(['guest_players', 'trainer_id', TRAINER_A]);
  });

  it('rejects guest not owned by trainer', async () => {
    maybeSingleMock.mockImplementation((table: string) => {
      if (table === 'guest_players') {
        return Promise.resolve({ data: null, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });

    await expect(
      removePlayerFromTrainer({
        trainerProfileId: TRAINER_A,
        guestPlayerId: GUEST_ID,
        profileId: null,
      }),
    ).rejects.toThrow('playerNotOwnedByTrainer');
  });

  it('rejects registered player not visible to trainer', async () => {
    visibleMock.mockResolvedValue(false);

    await expect(
      removePlayerFromTrainer({
        trainerProfileId: TRAINER_A,
        guestPlayerId: null,
        profileId: PROFILE_ID,
      }),
    ).rejects.toThrow('playerNotVisibleToTrainer');
  });

  it('rejects invalid player key', async () => {
    await expect(
      removePlayerFromTrainer({
        trainerProfileId: TRAINER_A,
        guestPlayerId: null,
        profileId: null,
      }),
    ).rejects.toThrow('invalidPlayerKey');
  });
});
