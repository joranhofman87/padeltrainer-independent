import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildGuestPlayerUpdatePayload,
  buildRegisteredProfileUpdatePayload,
  canEditRegisteredPlayerEmail,
  saveAcademyPlayerDetails,
  validatePlayerDetailsForm,
} from './academyPlayerDetails';

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
        locationName: '',
        skillRating: '',
        ratingSystem: 'knltb',
        notes: '',
      }),
    ).toBe('nameRequired');
  });

  it('does not allow registered email edits', () => {
    expect(canEditRegisteredPlayerEmail()).toBe(false);
  });

  it('builds guest update payload with preferred location and notes', () => {
    const payload = buildGuestPlayerUpdatePayload({
      name: 'Jane Guest',
      email: 'jane@example.com',
      locationId: 'loc-1',
      locationName: 'Club A',
      skillRating: '4.5',
      ratingSystem: 'knltb',
      notes: 'Intake note',
    });

    expect(payload).toMatchObject({
      full_name: 'Jane Guest',
      email: 'jane@example.com',
      preferred_location_id: 'loc-1',
      skill_rating: 4.5,
      rating_system: 'knltb',
      notes: 'Intake note',
    });
    expect(payload).not.toHaveProperty('location');
  });

  it('builds registered profile payload without email', () => {
    const payload = buildRegisteredProfileUpdatePayload({
      name: 'John Player',
      email: 'john@example.com',
      locationId: '',
      locationName: 'Club B',
      skillRating: '6',
      ratingSystem: 'knltb',
      notes: 'Internal note',
    });

    expect(payload).toMatchObject({
      full_name: 'John Player',
      location: 'Club B',
      skill_rating: 6,
      rating_system: 'knltb',
    });
    expect(payload).not.toHaveProperty('email');
  });

  it('includes email in guest player update payload', async () => {
    await saveAcademyPlayerDetails({
      kind: 'guest',
      academyProfileId: 'academy-1',
      guestPlayerId: 'guest-1',
      profileId: null,
      form: {
        name: 'Jane Guest',
        email: 'new-email@example.com',
        locationId: 'loc-1',
        locationName: 'Club A',
        skillRating: '4',
        ratingSystem: 'knltb',
        notes: 'Note',
      },
    });

    expect(updateMock).toHaveBeenCalledWith(
      'guest_players',
      expect.objectContaining({
        email: 'new-email@example.com',
      }),
    );
  });

  it('saves guest player to guest_players scoped by id', async () => {
    await saveAcademyPlayerDetails({
      kind: 'guest',
      academyProfileId: 'academy-1',
      guestPlayerId: 'guest-1',
      profileId: null,
      form: {
        name: 'Jane Guest',
        email: 'jane@example.com',
        locationId: 'loc-1',
        locationName: 'Club A',
        skillRating: '4',
        ratingSystem: 'knltb',
        notes: 'Note',
      },
    });

    expect(updateMock).toHaveBeenCalledWith(
      'guest_players',
      expect.objectContaining({
        full_name: 'Jane Guest',
        preferred_location_id: 'loc-1',
        notes: 'Note',
      }),
    );
    expect(eqMock).toHaveBeenCalledWith('guest_players', 'id', 'guest-1');
  });

  it('never sends email in registered profile update even when form email differs', async () => {
    await saveAcademyPlayerDetails({
      kind: 'registered',
      academyProfileId: 'academy-1',
      guestPlayerId: null,
      profileId: 'profile-1',
      form: {
        name: 'John Player',
        email: 'tampered@example.com',
        locationId: '',
        locationName: 'Club B',
        skillRating: '5',
        ratingSystem: 'knltb',
        notes: 'Team note',
      },
    });

    const profileUpdate = updateMock.mock.calls.find(([table]) => table === 'profiles');
    expect(profileUpdate?.[1]).not.toHaveProperty('email');
  });

  it('saves registered player name, club, level, and notes', async () => {
    await saveAcademyPlayerDetails({
      kind: 'registered',
      academyProfileId: 'academy-1',
      guestPlayerId: null,
      profileId: 'profile-1',
      form: {
        name: 'John Player',
        email: 'john@example.com',
        locationId: '',
        locationName: 'Club B',
        skillRating: '5',
        ratingSystem: 'knltb',
        notes: 'Team note',
      },
    });

    expect(updateMock).toHaveBeenCalledWith(
      'profiles',
      expect.objectContaining({
        full_name: 'John Player',
        location: 'Club B',
        skill_rating: 5,
      }),
    );
    expect(eqMock).toHaveBeenCalledWith('profiles', 'id', 'profile-1');
    expect(insertMock).toHaveBeenCalledWith(
      'academy_player_metadata',
      expect.objectContaining({
        academy_profile_id: 'academy-1',
        profile_id: 'profile-1',
        notes: 'Team note',
      }),
    );
  });
});
