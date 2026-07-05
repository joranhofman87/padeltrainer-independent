import { describe, expect, it, vi, beforeEach } from 'vitest';
import { findExistingGuestPlayerIdByEmail, resolveOrCreateGuestPlayer } from './playerResolve';

const insertMock = vi.fn();
const updateMock = vi.fn();
const emailLookupMock = vi.fn();

// Queue of result LISTS for successive select('id, full_name') email lookups
// (shared emails are allowed, so the lookup returns multiple rows).
let emailLookupResults: Array<Array<{ id: string; full_name: string | null }>> = [];
// Result for the patch row lookup (select of patchable columns).
let patchRowResult: Record<string, unknown> | null = null;
// Result of insert(...).select('id').single().
let insertResult: { data: { id: string } | null; error: { code?: string; message: string } | null } = {
  data: { id: 'new-guest' },
  error: null,
};
let academyTrainersResult: Array<{ trainer_profile_id: string }> = [];

function thenableBuilder(resolved: unknown) {
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    or: () => builder,
    in: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: () => Promise.resolve(resolved),
    single: () => Promise.resolve(resolved),
    then: (
      onFulfilled: (v: unknown) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => Promise.resolve(resolved).then(onFulfilled, onRejected),
  };
  return builder;
}

const fromMock = vi.fn((table: string) => {
  if (table === 'guest_players') {
    return {
      select: (cols: string) => {
        if (cols === 'id, full_name') {
          emailLookupMock();
          const next = emailLookupResults.length > 0 ? emailLookupResults.shift()! : [];
          return thenableBuilder({ data: next, error: null });
        }
        return thenableBuilder({ data: patchRowResult, error: null });
      },
      insert: (payload: unknown) => {
        insertMock(payload);
        return {
          select: () => ({ single: () => Promise.resolve(insertResult) }),
        };
      },
      update: (patch: unknown) => {
        updateMock(patch);
        return thenableBuilder({ data: null, error: null });
      },
    };
  }
  if (table === 'academy_trainers') {
    return thenableBuilder({ data: academyTrainersResult, error: null });
  }
  return thenableBuilder({ data: null, error: null });
});

// P2-2: the academy email-dedup branch now routes through the SECURITY DEFINER RPC
// find_guest_players_by_email_for_academy. Mock it to return the next queued
// email-lookup result (the dedup candidates), mirroring the prod RPC shape.
const rpcMock = vi.fn((fn: string) => {
  if (fn === 'find_guest_players_by_email_for_academy') {
    emailLookupMock();
    const next = emailLookupResults.length > 0 ? emailLookupResults.shift()! : [];
    return Promise.resolve({ data: next, error: null });
  }
  return Promise.resolve({ data: null, error: null });
});

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: (...args: unknown[]) => fromMock(...(args as [string])),
    rpc: (...args: unknown[]) => rpcMock(...(args as [string])),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  emailLookupResults = [];
  patchRowResult = null;
  insertResult = { data: { id: 'new-guest' }, error: null };
  academyTrainersResult = [];
});

describe('findExistingGuestPlayerIdByEmail', () => {
  it('returns null for empty email without querying', async () => {
    const id = await findExistingGuestPlayerIdByEmail('   ', { kind: 'trainer', trainerId: 't1' });
    expect(id).toBeNull();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('finds a trainer-scoped guest by email (single match, no name needed)', async () => {
    emailLookupResults = [[{ id: 'existing-by-email', full_name: 'Jan Jansen' }]];
    const id = await findExistingGuestPlayerIdByEmail('dup@test.com', {
      kind: 'trainer',
      trainerId: 't1',
    });
    expect(id).toBe('existing-by-email');
  });

  it('finds an academy-scoped guest by email (including trainer-owned rows)', async () => {
    academyTrainersResult = [{ trainer_profile_id: 't9' }];
    emailLookupResults = [[{ id: 'academy-existing', full_name: 'Jan Jansen' }]];
    const id = await findExistingGuestPlayerIdByEmail('dup@test.com', {
      kind: 'academy',
      academyProfileId: 'a1',
    });
    expect(id).toBe('academy-existing');
    expect(fromMock).toHaveBeenCalledWith('academy_trainers');
  });

  it('disambiguates a shared email by full name (diacritic/case-insensitive)', async () => {
    emailLookupResults = [
      [
        { id: 'kid-a', full_name: 'Anna Jansen' },
        { id: 'kid-b', full_name: 'José Jansen' },
      ],
    ];
    const id = await findExistingGuestPlayerIdByEmail(
      'family@test.com',
      { kind: 'trainer', trainerId: 't1' },
      '  jose jansen ',
    );
    expect(id).toBe('kid-b');
  });

  it('returns null for a shared email when the name matches none of the players', async () => {
    emailLookupResults = [
      [
        { id: 'kid-a', full_name: 'Anna Jansen' },
        { id: 'kid-b', full_name: 'José Jansen' },
      ],
    ];
    const id = await findExistingGuestPlayerIdByEmail(
      'family@test.com',
      { kind: 'trainer', trainerId: 't1' },
      'Kees Jansen',
    );
    expect(id).toBeNull();
  });

  it('returns null for a shared email when no name is given', async () => {
    emailLookupResults = [
      [
        { id: 'kid-a', full_name: 'Anna Jansen' },
        { id: 'kid-b', full_name: 'José Jansen' },
      ],
    ];
    const id = await findExistingGuestPlayerIdByEmail('family@test.com', {
      kind: 'trainer',
      trainerId: 't1',
    });
    expect(id).toBeNull();
  });
});

describe('resolveOrCreateGuestPlayer', () => {
  it('returns null when full name is empty', async () => {
    const id = await resolveOrCreateGuestPlayer({
      scope: { kind: 'trainer', trainerId: 't1' },
      fullName: '   ',
      email: 'x@test.com',
    });
    expect(id).toBeNull();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('reuses an existing guest by email instead of inserting (trainer scope)', async () => {
    emailLookupResults = [[{ id: 'existing-by-email', full_name: 'Jan Jansen' }]];
    const id = await resolveOrCreateGuestPlayer({
      scope: { kind: 'trainer', trainerId: 't1' },
      fullName: 'Jan Jansen',
      email: 'jan@test.com',
    });
    expect(id).toBe('existing-by-email');
    expect(insertMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('reuses the name-matching guest when the email is shared', async () => {
    emailLookupResults = [
      [
        { id: 'kid-a', full_name: 'Anna Jansen' },
        { id: 'kid-b', full_name: 'José Jansen' },
      ],
    ];
    const id = await resolveOrCreateGuestPlayer({
      scope: { kind: 'trainer', trainerId: 't1' },
      fullName: 'Jose Jansen',
      email: 'family@test.com',
    });
    expect(id).toBe('kid-b');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('creates a NEW player when the shared email matches no name (kid B gets own record)', async () => {
    emailLookupResults = [
      [
        { id: 'kid-a', full_name: 'Anna Jansen' },
        { id: 'kid-b', full_name: 'José Jansen' },
      ],
    ];
    const id = await resolveOrCreateGuestPlayer({
      scope: { kind: 'trainer', trainerId: 't1' },
      fullName: 'Kees Jansen',
      email: 'family@test.com',
    });
    expect(id).toBe('new-guest');
    expect(insertMock).toHaveBeenCalledTimes(1);
    const payload = insertMock.mock.calls[0][0];
    expect(payload.full_name).toBe('Kees Jansen');
    expect(payload.email).toBe('family@test.com');
  });

  it('inserts an emailless guest without any dedup lookup', async () => {
    const id = await resolveOrCreateGuestPlayer({
      scope: { kind: 'trainer', trainerId: 't1' },
      fullName: 'Walk-in Wendy',
      email: '',
    });
    expect(id).toBe('new-guest');
    expect(emailLookupMock).not.toHaveBeenCalled();
    expect(insertMock).toHaveBeenCalledTimes(1);
    const payload = insertMock.mock.calls[0][0];
    expect(payload.trainer_id).toBe('t1');
    expect(payload.full_name).toBe('Walk-in Wendy');
    expect(payload.first_name).toBe('Walk-in');
    expect(payload.last_name).toBe('Wendy');
    expect(payload.email).toBeUndefined();
  });

  it('inserts a trainer-scoped guest with cycle fields populated', async () => {
    const id = await resolveOrCreateGuestPlayer({
      scope: { kind: 'trainer', trainerId: 't1' },
      fullName: 'Jan Jansen',
      email: 'jan@test.com',
      phone: '+31612345678',
      skillRating: 6.5,
      ratingSystem: 'knltb',
      birthDate: '1990-05-01',
      linkedProfileId: 'profile-1',
      source: 'cycle_registration',
      hasTrained: false,
    });
    expect(id).toBe('new-guest');
    const payload = insertMock.mock.calls[0][0];
    expect(payload).toMatchObject({
      trainer_id: 't1',
      full_name: 'Jan Jansen',
      first_name: 'Jan',
      last_name: 'Jansen',
      email: 'jan@test.com',
      phone: '+31612345678',
      skill_rating: 6.5,
      rating_system: 'knltb',
      birth_date: '1990-05-01',
      linked_profile_id: 'profile-1',
      source: 'cycle_registration',
      has_trained: false,
    });
  });

  it('inserts an academy-scoped guest with academy_profile_id', async () => {
    const id = await resolveOrCreateGuestPlayer({
      scope: { kind: 'academy', academyProfileId: 'a1' },
      fullName: 'Piet',
      email: 'piet@test.com',
      source: 'cycle_registration',
    });
    expect(id).toBe('new-guest');
    const payload = insertMock.mock.calls[0][0];
    expect(payload.academy_profile_id).toBe('a1');
    expect(payload.trainer_id).toBeUndefined();
    expect(payload.source).toBe('cycle_registration');
  });

  it('falls back to re-select on insert unique violation (23505 race)', async () => {
    emailLookupResults = [[], [{ id: 'raced-existing', full_name: 'Jan' }]];
    insertResult = { data: null, error: { code: '23505', message: 'duplicate key value' } };
    const id = await resolveOrCreateGuestPlayer({
      scope: { kind: 'trainer', trainerId: 't1' },
      fullName: 'Jan',
      email: 'jan@test.com',
    });
    expect(id).toBe('raced-existing');
    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(emailLookupMock).toHaveBeenCalledTimes(2);
  });

  it('returns null on non-unique insert errors', async () => {
    insertResult = { data: null, error: { code: '42501', message: 'rls violation' } };
    const id = await resolveOrCreateGuestPlayer({
      scope: { kind: 'trainer', trainerId: 't1' },
      fullName: 'Jan',
      email: 'jan@test.com',
    });
    expect(id).toBeNull();
  });

  it('patchExistingEmptyFields fills only null/empty fields on the existing row', async () => {
    emailLookupResults = [[{ id: 'existing-by-email', full_name: 'Jan Jansen' }]];
    patchRowResult = {
      phone: null,
      skill_rating: 7,
      rating_system: 'knltb',
      birth_date: '',
      linked_profile_id: null,
    };
    const id = await resolveOrCreateGuestPlayer({
      scope: { kind: 'trainer', trainerId: 't1' },
      fullName: 'Jan Jansen',
      email: 'jan@test.com',
      phone: '+31611111111',
      skillRating: 5,
      ratingSystem: 'utr',
      birthDate: '1992-02-02',
      linkedProfileId: 'profile-9',
      patchExistingEmptyFields: true,
    });
    expect(id).toBe('existing-by-email');
    expect(insertMock).not.toHaveBeenCalled();
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.calls[0][0]).toEqual({
      phone: '+31611111111',
      birth_date: '1992-02-02',
      linked_profile_id: 'profile-9',
    });
  });

  it('patchExistingEmptyFields skips the update when nothing is empty', async () => {
    emailLookupResults = [[{ id: 'existing-by-email', full_name: 'Jan' }]];
    patchRowResult = {
      phone: '+31600000000',
      skill_rating: 7,
      rating_system: 'knltb',
      birth_date: '1990-01-01',
      linked_profile_id: 'profile-1',
    };
    const id = await resolveOrCreateGuestPlayer({
      scope: { kind: 'academy', academyProfileId: 'a1' },
      fullName: 'Jan',
      email: 'jan@test.com',
      phone: '+31611111111',
      skillRating: 5,
      birthDate: '1992-02-02',
      linkedProfileId: 'profile-9',
      patchExistingEmptyFields: true,
    });
    expect(id).toBe('existing-by-email');
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('does not patch when patchExistingEmptyFields is not set', async () => {
    emailLookupResults = [[{ id: 'existing-by-email', full_name: 'Jan' }]];
    const id = await resolveOrCreateGuestPlayer({
      scope: { kind: 'trainer', trainerId: 't1' },
      fullName: 'Jan',
      email: 'jan@test.com',
      phone: '+31611111111',
    });
    expect(id).toBe('existing-by-email');
    expect(updateMock).not.toHaveBeenCalled();
  });
});
