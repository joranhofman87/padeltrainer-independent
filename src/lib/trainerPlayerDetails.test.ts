import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validatePlayerDetailsForm } from '@/lib/academyPlayerDetails';
import { saveTrainerPlayerDetails as saveTrainerDetails } from './trainerPlayerDetails';

const LOC_A = '11111111-1111-4111-8111-111111111111';
const allowedLocationIds = new Set([LOC_A]);

const updateMock = vi.fn();
const eqMock = vi.fn();
const insertMock = vi.fn();
const maybeSingleMock = vi.fn();

function createChain(table: string) {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: (...args: unknown[]) => {
      eqMock(table, ...args);
      return chain;
    },
    update: (payload: unknown) => {
      updateMock(table, payload);
      const updateChain: Record<string, unknown> = {
        eq: (...args: unknown[]) => {
          eqMock(table, ...args);
          return updateChain;
        },
        then: (
          onFulfilled: (v: { error: null }) => unknown,
          onRejected?: (e: unknown) => unknown,
        ) => Promise.resolve({ error: null }).then(onFulfilled, onRejected),
      };
      return updateChain;
    },
    insert: (payload: unknown) => {
      insertMock(table, payload);
      return Promise.resolve({ error: null });
    },
    maybeSingle: () => maybeSingleMock(table),
    not: () => chain,
  };
  return chain;
}

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: (table: string) => createChain(table),
  },
}));

describe('trainerPlayerDetails save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    maybeSingleMock.mockResolvedValue({ data: null, error: null });
  });

  it('updates guest players scoped to trainer_id', async () => {
    await saveTrainerDetails({
      kind: 'guest',
      trainerProfileId: 'trainer-1',
      guestPlayerId: 'guest-1',
      profileId: null,
      form: {
        name: 'Jane Guest',
        email: 'jane@example.com',
        phone: '',
        locationId: LOC_A,
        skillRating: '4.5',
        ratingSystem: 'knltb',
        notes: 'Hello',
      },
      allowedLocationIds,
    });

    expect(updateMock).toHaveBeenCalledWith(
      'guest_players',
      expect.objectContaining({
        email: 'jane@example.com',
        preferred_location_id: LOC_A,
      }),
    );
    expect(eqMock).toHaveBeenCalledWith('guest_players', 'trainer_id', 'trainer-1');
  });

  it('does not include email in registered profile payload', async () => {
    await saveTrainerDetails({
      kind: 'registered',
      trainerProfileId: 'trainer-1',
      guestPlayerId: null,
      profileId: 'profile-1',
      form: {
        name: 'Registered Player',
        email: 'should-not-update@example.com',
        phone: '',
        locationId: LOC_A,
        skillRating: '5',
        ratingSystem: 'knltb',
        notes: 'Trainer notes',
      },
      allowedLocationIds,
    });

    const profileUpdate = updateMock.mock.calls.find(([table]) => table === 'profiles')?.[1];
    expect(profileUpdate).toBeDefined();
    expect(profileUpdate).not.toHaveProperty('email');
    expect(insertMock).toHaveBeenCalledWith(
      'academy_player_metadata',
      expect.objectContaining({
        trainer_profile_id: 'trainer-1',
        profile_id: 'profile-1',
        notes: 'Trainer notes',
      }),
    );
  });
});

describe('validatePlayerDetailsForm (shared)', () => {
  it('rejects empty name', () => {
    expect(
      validatePlayerDetailsForm({
        name: ' ',
        email: '',
        phone: '',
        locationId: '',
        skillRating: '',
        ratingSystem: 'knltb',
        notes: '',
      }),
    ).toBe('nameRequired');
  });
});
