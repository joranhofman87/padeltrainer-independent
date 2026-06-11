import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildGuestPlayerUpdatePayload,
  buildRegisteredProfileUpdatePayload,
  canEditRegisteredPlayerEmail,
  coalesceLinkedGuestIdentity,
  fetchLinkedProfileIdentity,
  isLinkedGuest,
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
        phone: '',
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
          phone: '',
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
        phone: '',
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
      phone: '',
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
        phone: '',
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
    // Unlinked guests never touch profiles.
    expect(updateMock).not.toHaveBeenCalledWith('profiles', expect.anything());
  });

  it('flags linked guests so email becomes read-only', () => {
    expect(isLinkedGuest('guest', 'guest-1', 'profile-1')).toBe(true);
    expect(isLinkedGuest('guest', 'guest-1', null)).toBe(false);
    expect(isLinkedGuest('registered', null, 'profile-1')).toBe(false);
  });

  it('coalesces linked guest identity with profile-first precedence', () => {
    const guest = {
      full_name: 'Guest Name',
      email: 'guest@example.com',
      phone: '0611111111',
      skill_rating: 4,
      rating_system: 'knltb',
      birth_date: '1990-01-01',
    };

    expect(
      coalesceLinkedGuestIdentity(guest, {
        full_name: 'Profile Name',
        email: 'profile@example.com',
        phone: '0622222222',
        skill_rating: 6.5,
        rating_system: 'dupr',
        birth_date: '1991-02-02',
      }),
    ).toEqual({
      full_name: 'Profile Name',
      email: 'profile@example.com',
      phone: '0622222222',
      skill_rating: 6.5,
      rating_system: 'dupr',
      // birth_date is relationship data: guest-first, profile fallback.
      birth_date: '1990-01-01',
    });

    // Empty/blank profile values fall back to the guest copy.
    expect(
      coalesceLinkedGuestIdentity(guest, {
        full_name: '  ',
        email: null,
        phone: '',
        skill_rating: null,
        rating_system: '',
        birth_date: '1991-02-02',
      }),
    ).toEqual(guest);

    // Guest without birth_date falls back to the profile's.
    expect(
      coalesceLinkedGuestIdentity(
        { ...guest, birth_date: null },
        { full_name: null, email: null, phone: null, skill_rating: null, rating_system: null, birth_date: '1991-02-02' },
      ).birth_date,
    ).toBe('1991-02-02');

    // No linked profile row: guest values pass through.
    expect(coalesceLinkedGuestIdentity(guest, null)).toEqual(guest);
  });

  it('fetches linked profile identity from profiles', async () => {
    maybeSingleMock.mockImplementation((table: string) =>
      Promise.resolve(
        table === 'profiles'
          ? {
              data: {
                full_name: 'Profile Name',
                email: 'profile@example.com',
                phone: null,
                skill_rating: 6,
                rating_system: 'knltb',
                birth_date: null,
              },
              error: null,
            }
          : { data: null, error: null },
      ),
    );

    const profile = await fetchLinkedProfileIdentity('profile-1');

    expect(eqMock).toHaveBeenCalledWith('profiles', 'id', 'profile-1');
    expect(profile).toMatchObject({ full_name: 'Profile Name', email: 'profile@example.com' });
  });

  it('writes identity to profiles and mirrors the guest row (email untouched) for linked guests', async () => {
    await saveAcademyPlayerDetails({
      kind: 'guest',
      academyProfileId: 'academy-1',
      guestPlayerId: 'guest-1',
      profileId: 'profile-1',
      allowedLocationIds,
      form: {
        name: 'Jane Linked',
        email: 'tampered@example.com',
        phone: '0612345678',
        locationId: LOC_A,
        skillRating: '5.5',
        ratingSystem: 'knltb',
        notes: 'Intake note',
      },
    });

    const profileUpdate = updateMock.mock.calls.find(([table]) => table === 'profiles')?.[1];
    expect(profileUpdate).toMatchObject({
      first_name: 'Jane',
      last_name: 'Linked',
      full_name: 'Jane Linked',
      phone: '0612345678',
      skill_rating: 5.5,
      rating_system: 'knltb',
    });
    expect(profileUpdate).not.toHaveProperty('email');
    expect(profileUpdate).not.toHaveProperty('location');
    expect(eqMock).toHaveBeenCalledWith('profiles', 'id', 'profile-1');

    const guestUpdate = updateMock.mock.calls.find(([table]) => table === 'guest_players')?.[1];
    expect(guestUpdate).toMatchObject({
      first_name: 'Jane',
      last_name: 'Linked',
      full_name: 'Jane Linked',
      phone: '0612345678',
      skill_rating: 5.5,
      rating_system: 'knltb',
      notes: 'Intake note',
      preferred_location_id: LOC_A,
    });
    expect(guestUpdate).not.toHaveProperty('email');
    expect(eqMock).toHaveBeenCalledWith('guest_players', 'id', 'guest-1');
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
        phone: '',
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
