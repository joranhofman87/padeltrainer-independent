import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isPlayerRemovedFromAcademy,
  shouldShowPlayerInAcademyOverview,
  removePlayerFromAcademy,
} from './academyPlayerRemoval';
import { isOverlayWriteDisabledError } from './overlayWriteContainment';

const ACADEMY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GUEST_ID = 'gggggggg-gggg-4ggg-8ggg-gggggggggggg';
const PROFILE_ID = 'pppppppp-pppp-4ppp-8ppp-pppppppppppp';
const MANAGER_ID = 'uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu';

/**
 * The supabase client is mocked to RECORD any use and to fail loudly if the module reaches
 * for it. Under ABC-16 H0 the interesting property is not "which payload is written" — it is
 * that NOTHING is written and no request leaves the client, so the mock exists to prove the
 * negative rather than to satisfy a chain.
 */
const fromMock = vi.fn((_table: string) => {
  throw new Error('the supabase client must not be reached while overlay writes are contained');
});

vi.mock('@/lib/supabaseClient', () => ({ supabase: { from: (t: string) => fromMock(t) } }));

describe('academyPlayerRemoval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('detects removed metadata', () => {
    expect(isPlayerRemovedFromAcademy({ removed_at: '2026-01-01T00:00:00Z' })).toBe(true);
    expect(isPlayerRemovedFromAcademy({ removed_at: null })).toBe(false);
    expect(shouldShowPlayerInAcademyOverview({ removed_at: '2026-01-01T00:00:00Z' })).toBe(false);
    expect(shouldShowPlayerInAcademyOverview(null)).toBe(true);
  });

  // ── ABC-16 H0 ────────────────────────────────────────────────────────────────────────────
  // These cases previously asserted that soft removal INSERTED or UPDATED
  // `academy_player_metadata`. That write is exactly the defect: it created, for a
  // caller-chosen subject, the row three authorization predicates accepted as proof of the
  // academy↔player relationship. The expectations are inverted rather than deleted, so the
  // suite still pins the behaviour of every case it used to cover.

  it('refuses to soft-remove a guest, and sends no request', async () => {
    await expect(
      removePlayerFromAcademy({
        academyProfileId: ACADEMY_A,
        guestPlayerId: GUEST_ID,
        profileId: null,
        removedByProfileId: MANAGER_ID,
      }),
    ).rejects.toSatisfy(isOverlayWriteDisabledError);

    expect(fromMock).not.toHaveBeenCalled();
  });

  it('refuses for a linked guest too — neither identity is written', async () => {
    await expect(
      removePlayerFromAcademy({
        academyProfileId: ACADEMY_A,
        guestPlayerId: GUEST_ID,
        profileId: PROFILE_ID,
        removedByProfileId: MANAGER_ID,
      }),
    ).rejects.toSatisfy(isOverlayWriteDisabledError);

    expect(fromMock).not.toHaveBeenCalled();
  });

  it('refuses for a registered player', async () => {
    await expect(
      removePlayerFromAcademy({
        academyProfileId: ACADEMY_A,
        guestPlayerId: null,
        profileId: PROFILE_ID,
        removedByProfileId: MANAGER_ID,
      }),
    ).rejects.toSatisfy(isOverlayWriteDisabledError);

    expect(fromMock).not.toHaveBeenCalled();
  });

  it('the refusal is a plain-language message, never a raw permission error', async () => {
    const err = await removePlayerFromAcademy({
      academyProfileId: ACADEMY_A,
      guestPlayerId: GUEST_ID,
      profileId: null,
    }).catch((e) => e as Error);

    expect(err.message).not.toMatch(/permission denied|row-level security|42501/i);
    expect(err.message).toMatch(/read-only/i);
    // it must also say that nothing changed — a failed destructive action that is ambiguous
    // about what it did is worse than one that failed loudly.
    expect(err.message).toMatch(/nothing was changed/i);
  });

  it('rejects an invalid player key BEFORE the containment — the caller keeps that diagnosis', async () => {
    await expect(
      removePlayerFromAcademy({
        academyProfileId: ACADEMY_A,
        guestPlayerId: null,
        profileId: null,
      }),
    ).rejects.toThrow('invalidPlayerKey');
  });
});
