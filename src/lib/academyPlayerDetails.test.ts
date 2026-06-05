import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildGuestPlayerUpdatePayload,
  buildRegisteredProfileUpdatePayload,
  canEditRegisteredPlayerEmail,
  saveAcademyPlayerDetails,
  validatePlayerDetailsForm,
} from './academyPlayerDetails';

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
      return {
        eq: (...args: unknown[]) => {
          eqMock(table, ...args);
          return Promise.resolve({ error: null });
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

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: (table: string) => createChain(table),
  },
}));

describe('academyPlayerDetails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    maybeSingleMock.mockResolvedValue({ data: null, error: null });
  });

  it('rejects empty name', () => {
    expect(
      validatePlayerDetailsForm({
        name: ' ',
        email: '',
        locationId: '',
        skillRating: '',
        ratingSystem: 'knltb',
        notes: '',
      }),
    ).toBe('nameRequired');
  });

  it('rejects free-text preferred club ids', () => {
    expect(
      validatePlayerDetailsForm(
        {
          name: 'Jane',
          email: '',
          locationId: 'Padel Club Amsterdam',
          skillRating: '',
          ratingSystem: 'knltb',
          notes: '',
        },
        allowedLocationIds,
      ),
    ).toBe('invalidLocationId');
  });

  it('does not allow registered email edits', () => {
    expect(canEditRegisteredPlayerEmail()).toBe(false);
  });

  it('builds guest update payload with preferred_location_id only', () => {
    const payload = buildGuestPlayerUpdatePayload(
      {
        name: 'Jane Guest',
        email: 'jane@example.com',
        locationId: LOC_A,
        skillRating: '4.5',
        ratingSystem: 'knltb',
        notes: 'Intake note',
      },
      allowedLocationIds,
    );

    expect(payload).toMatchObject({
      full_name: 'Jane Guest',
      email: 'jane@example.com',
      preferred_location_id: LOC_A,
      skill_rating: 4.5,
      rating_system: 'knltb',
      notes: 'Intake note',
    });
    expect(payload).not.toHaveProperty('location');
  });

  it('builds registered profile payload without email or location', () => {
    const payload = buildRegisteredProfileUpdatePayload({
      name: 'John Player',
      email: 'john@example.com',
      locationId: LOC_A,
      skillRating: '6',
      ratingSystem: 'knltb',
      notes: 'Internal note',
    });

    expect(payload).toMatchObject({
      full_name: 'John Player',
      skill_rating: 6,
      rating_system: 'knltb',
    });
    expect(payload).not.toHaveProperty('email');
    expect(payload).not.toHaveProperty('location');
  });

  it('includes email in guest player update payload', async () => {
    await saveAcademyPlayerDetails({
      kind: 'guest',
      academyProfileId: 'academy-1',
      guestPlayerId: 'guest-1',
      profileId: null,
      allowedLocationIds,
      form: {
        name: 'Jane Guest',
        email: 'new-email@example.com',
        locationId: LOC_A,
        skillRating: '4',
        ratingSystem: 'knltb',
        notes: 'Note',
      },
    });

    expect(updateMock).toHaveBeenCalledWith(
      'guest_players',
      expect.objectContaining({
        email: 'new-email@example.com',
        preferred_location_id: LOC_A,
      }),
    );
  });

  it('never sends email or location in registered profile update', async () => {
    await saveAcademyPlayerDetails({
      kind: 'registered',
      academyProfileId: 'academy-1',
      guestPlayerId: null,
      profileId: 'profile-1',
      allowedLocationIds,
      form: {
        name: 'John Player',
        email: 'tampered@example.com',
        locationId: LOC_A,
        skillRating: '5',
        ratingSystem: 'knltb',
        notes: 'Team note',
      },
    });

    const profileUpdate = updateMock.mock.calls.find(([table]) => table === 'profiles');
    expect(profileUpdate?.[1]).not.toHaveProperty('email');
    expect(profileUpdate?.[1]).not.toHaveProperty('location');

    expect(insertMock).toHaveBeenCalledWith(
      'academy_player_metadata',
      expect.objectContaining({
        academy_profile_id: 'academy-1',
        profile_id: 'profile-1',
        notes: 'Team note',
        preferred_location_id: LOC_A,
      }),
    );
  });
});
