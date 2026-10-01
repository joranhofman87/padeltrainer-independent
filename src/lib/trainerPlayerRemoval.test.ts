import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isPlayerRemovedFromTrainer,
  shouldShowPlayerInTrainerOverview,
  removePlayerFromTrainer,
} from './trainerPlayerRemoval';
import { isOverlayWriteDisabledError } from './overlayWriteContainment';

const TRAINER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GUEST_ID = 'gggggggg-gggg-4ggg-8ggg-gggggggggggg';
const PROFILE_ID = 'pppppppp-pppp-4ppp-8ppp-pppppppppppp';
const MANAGER_ID = 'uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu';

const visibleMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const eqCalls: Array<[string, ...unknown[]]> = [];
const maybeSingleMock = vi.fn();

/**
 * The ownership assertion still runs and still reads `guest_players`, so this chain stays —
 * but any INSERT/UPDATE is recorded so the suite can prove the overlay is never written.
 */
function createChain(table: string) {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: (...args: unknown[]) => { eqCalls.push([table, ...args]); return chain; },
    update: (payload: unknown) => { updateMock(table, payload); return chain; },
    insert: (payload: unknown) => { insertMock(table, payload); return Promise.resolve({ error: null }); },
    maybeSingle: () => maybeSingleMock(table),
  };
  return chain;
}

vi.mock('@/lib/invoiceSelectablePlayers', () => ({
  isTrainerRegisteredPlayerVisible: (...args: unknown[]) => visibleMock(...args),
}));

vi.mock('@/lib/supabaseClient', () => ({ supabase: { from: (table: string) => createChain(table) } }));

describe('trainerPlayerRemoval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eqCalls.length = 0;
    maybeSingleMock.mockImplementation((table: string) =>
      Promise.resolve(table === 'guest_players' ? { data: { id: GUEST_ID }, error: null } : { data: null, error: null }));
    visibleMock.mockResolvedValue(true);
  });

  it('detects removed metadata', () => {
    expect(isPlayerRemovedFromTrainer({ removed_at: '2026-01-01T00:00:00Z' })).toBe(true);
    expect(isPlayerRemovedFromTrainer({ removed_at: null })).toBe(false);
    expect(shouldShowPlayerInTrainerOverview({ removed_at: '2026-01-01T00:00:00Z' })).toBe(false);
    expect(shouldShowPlayerInTrainerOverview(null)).toBe(true);
  });

  // ── ABC-16 H0 ────────────────────────────────────────────────────────────────────────────
  // These cases used to assert the INSERT/UPDATE of `academy_player_metadata`. The trainer arm
  // has the same defect as the academy arm — its policy proves the caller owns the ROW, never
  // that the subject trains with them — so the expectations are inverted, not dropped.

  it('refuses to soft-remove a guest, writing nothing', async () => {
    await expect(
      removePlayerFromTrainer({
        trainerProfileId: TRAINER_A,
        guestPlayerId: GUEST_ID,
        profileId: null,
        removedByProfileId: MANAGER_ID,
      }),
    ).rejects.toSatisfy(isOverlayWriteDisabledError);

    expect(insertMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('refuses for a registered player, writing nothing', async () => {
    await expect(
      removePlayerFromTrainer({
        trainerProfileId: TRAINER_A,
        guestPlayerId: null,
        profileId: PROFILE_ID,
        removedByProfileId: MANAGER_ID,
      }),
    ).rejects.toSatisfy(isOverlayWriteDisabledError);

    expect(insertMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  // The ownership checks must keep their OWN diagnoses. A trainer acting on someone else's
  // player should learn that, not be told the feature is read-only — the two are different
  // problems and only one of them is temporary.
  it('still rejects a guest not owned by the trainer, ahead of the containment', async () => {
    maybeSingleMock.mockImplementation(() => Promise.resolve({ data: null, error: null }));

    await expect(
      removePlayerFromTrainer({ trainerProfileId: TRAINER_A, guestPlayerId: GUEST_ID, profileId: null }),
    ).rejects.toThrow('playerNotOwnedByTrainer');
  });

  it('still rejects a registered player not visible to the trainer', async () => {
    visibleMock.mockResolvedValue(false);

    await expect(
      removePlayerFromTrainer({ trainerProfileId: TRAINER_A, guestPlayerId: null, profileId: PROFILE_ID }),
    ).rejects.toThrow('playerNotVisibleToTrainer');
  });

  it('still rejects an invalid player key first of all', async () => {
    await expect(
      removePlayerFromTrainer({ trainerProfileId: TRAINER_A, guestPlayerId: null, profileId: null }),
    ).rejects.toThrow('invalidPlayerKey');
  });

  it('the ownership check runs BEFORE the containment (scoped to the given trainer)', async () => {
    await removePlayerFromTrainer({ trainerProfileId: TRAINER_A, guestPlayerId: GUEST_ID, profileId: null })
      .catch(() => { /* the containment refusal is asserted above */ });

    expect(eqCalls).toContainEqual(['guest_players', 'trainer_id', TRAINER_A]);
  });
});
