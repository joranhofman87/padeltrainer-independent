import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  findExistingGuestPlayerIdByEmail,
  resolveOrCreateGuestPlayer,
  resolveOrCreateGuestTwinForRegisteredPlayer,
} from './playerResolve';

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
    ilike: () => builder,
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

// Phase 0c twin bridge: queue of results for find_guest_twin_for_academy (shift per call; empty
// queue → null = "no twin yet"), an error toggle simulating a not-yet-pushed DB (fn missing), and
// the claim result — 'echo' means the CAS succeeded (returns the requested profile id, the common
// unclaimed-row case), any other value models already-claimed/conflict outcomes.
let twinLookupResults: Array<string | null> = [];
let twinLookupError = false;
let claimResult: string | null | 'echo' = 'echo';
let claimError = false;
const twinLookupMock = vi.fn();
const claimMock = vi.fn();

// P2-2: the academy email-dedup branch now routes through the SECURITY DEFINER RPC
// find_guest_players_by_email_for_academy. Mock it to return the next queued
// email-lookup result (the dedup candidates), mirroring the prod RPC shape.
const rpcMock = vi.fn((fn: string, params?: Record<string, unknown>) => {
  if (fn === 'find_guest_players_by_email_for_academy') {
    emailLookupMock();
    const next = emailLookupResults.length > 0 ? emailLookupResults.shift()! : [];
    return Promise.resolve({ data: next, error: null });
  }
  if (fn === 'find_guest_twin_for_academy') {
    twinLookupMock(params);
    if (twinLookupError) return Promise.resolve({ data: null, error: { message: 'missing fn' } });
    const next = twinLookupResults.length > 0 ? twinLookupResults.shift()! : null;
    return Promise.resolve({ data: next, error: null });
  }
  if (fn === 'claim_guest_twin_for_academy') {
    claimMock(params);
    if (claimError) return Promise.resolve({ data: null, error: { message: 'missing fn' } });
    const data = claimResult === 'echo' ? (params?._profile_id as string) : claimResult;
    return Promise.resolve({ data, error: null });
  }
  return Promise.resolve({ data: null, error: null });
});

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: (...args: unknown[]) => fromMock(...(args as [string])),
    rpc: (...args: unknown[]) => rpcMock(...(args as [string, Record<string, unknown>])),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  emailLookupResults = [];
  patchRowResult = null;
  insertResult = { data: { id: 'new-guest' }, error: null };
  academyTrainersResult = [];
  twinLookupResults = [];
  twinLookupError = false;
  claimResult = 'echo';
  claimError = false;
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

  it('returns null when SEVERAL rows share the email AND the exact name (audit H3: never guess)', async () => {
    emailLookupResults = [
      [
        { id: 'dup-old', full_name: 'Jan Jansen' },
        { id: 'dup-new', full_name: 'Jan Jansen' },
      ],
    ];
    const id = await findExistingGuestPlayerIdByEmail(
      'family@test.com',
      { kind: 'trainer', trainerId: 't1' },
      'Jan Jansen',
    );
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
      source: 'cycle_registration',
      has_trained: false,
    });
    // FAM-02 (Level 1): the resolver never links a guest to a profile anymore.
    expect(payload.linked_profile_id).toBeUndefined();
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

  it('the 23505 recovery honors requireNameMatch — a raced WRONG-NAME row is never reused', async () => {
    // First lookup empty → insert races → recovery re-select returns a DIFFERENT family member.
    emailLookupResults = [[], [{ id: 'child-row', full_name: 'Sofie de Vries' }]];
    insertResult = { data: null, error: { code: '23505', message: 'duplicate key value' } };
    const id = await resolveOrCreateGuestPlayer({
      scope: { kind: 'trainer', trainerId: 't1' },
      fullName: 'Mark de Vries',
      email: 'gezin@x.nl',
      requireNameMatch: true,
    });
    expect(id).toBeNull(); // hard stop, never the wrong person
  });

  it('patchExistingEmptyFields fills only null/empty fields on the existing row', async () => {
    emailLookupResults = [[{ id: 'existing-by-email', full_name: 'Jan Jansen' }]];
    patchRowResult = {
      phone: null,
      skill_rating: 7,
      rating_system: 'knltb',
      birth_date: '',
    };
    const id = await resolveOrCreateGuestPlayer({
      scope: { kind: 'trainer', trainerId: 't1' },
      fullName: 'Jan Jansen',
      email: 'jan@test.com',
      phone: '+31611111111',
      skillRating: 5,
      ratingSystem: 'utr',
      birthDate: '1992-02-02',
      patchExistingEmptyFields: true,
    });
    expect(id).toBe('existing-by-email');
    expect(insertMock).not.toHaveBeenCalled();
    expect(updateMock).toHaveBeenCalledTimes(1);
    // FAM-02 (Level 1): linked_profile_id is no longer patched onto an existing guest.
    expect(updateMock.mock.calls[0][0]).toEqual({
      phone: '+31611111111',
      birth_date: '1992-02-02',
    });
  });

  it('patchExistingEmptyFields skips the update when nothing is empty', async () => {
    emailLookupResults = [[{ id: 'existing-by-email', full_name: 'Jan' }]];
    patchRowResult = {
      phone: '+31600000000',
      skill_rating: 7,
      rating_system: 'knltb',
      birth_date: '1990-01-01',
    };
    const id = await resolveOrCreateGuestPlayer({
      scope: { kind: 'academy', academyProfileId: 'a1' },
      fullName: 'Jan',
      email: 'jan@test.com',
      phone: '+31611111111',
      skillRating: 5,
      birthDate: '1992-02-02',
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

describe('resolveOrCreateGuestTwinForRegisteredPlayer — ABC-18: the twin bridge is retired', () => {
  // This block previously pinned the find -> claim -> mint bridge: it asserted that the resolver
  // CLAIMED an email match, stamped `twin_of_profile_id`, and reused a claimed row. Every one of
  // those steps asserted "this guest row IS that registered person" from a mutable email plus a
  // name, and downstream that stamp was read as identity. The expectations are inverted rather
  // than deleted, so the same scenarios stay covered.

  it('resolves the guest-only path and never claims a twin', async () => {
    academyTrainersResult = [{ trainer_profile_id: 't1' }];
    emailLookupResults = [[{ id: 'guest-existing', full_name: 'Mark Jan Alewijn' }]];

    const id = await resolveOrCreateGuestTwinForRegisteredPlayer(
      { kind: 'academy', academyProfileId: 'a1' },
      { profileId: 'p1', fullName: 'Mark Jan Alewijn', email: '  MarkJan@Test.COM ' },
    );

    expect(id).toBe('guest-existing');
    expect(claimMock).not.toHaveBeenCalled();
  });

  it('never writes twin_of_profile_id when it has to create a row', async () => {
    academyTrainersResult = [{ trainer_profile_id: 't1' }];
    emailLookupResults = [[]];

    await resolveOrCreateGuestTwinForRegisteredPlayer(
      { kind: 'academy', academyProfileId: 'a1' },
      { profileId: 'p1', fullName: 'Nieuwe Speler', email: 'nieuw@test.com' },
    );

    for (const call of insertMock.mock.calls) {
      expect(call[0]).not.toHaveProperty('twin_of_profile_id');
      expect(call[0]).not.toHaveProperty('linked_profile_id');
    }
  });

  it('an emailless registered player still gets a plain guest row, unstamped', async () => {
    academyTrainersResult = [{ trainer_profile_id: 't1' }];

    await resolveOrCreateGuestTwinForRegisteredPlayer(
      { kind: 'academy', academyProfileId: 'a1' },
      { profileId: 'p1', fullName: 'Geen Mail' },
    );

    expect(claimMock).not.toHaveBeenCalled();
    for (const call of insertMock.mock.calls) {
      expect(call[0]).not.toHaveProperty('twin_of_profile_id');
    }
  });

  it('a trainer scope behaves identically — there is no academy-only bridge left', async () => {
    emailLookupResults = [[]];
    await resolveOrCreateGuestTwinForRegisteredPlayer(
      { kind: 'trainer', trainerProfileId: 't1' },
      { profileId: 'p1', fullName: 'Trainer Scope', email: 'ts@test.com' },
    );
    expect(claimMock).not.toHaveBeenCalled();
  });
});

describe('resolveOrCreateGuestTwinForRegisteredPlayer — wrong-person guard (audit #1)', () => {
  it('does NOT reuse a lone household-email match whose NAME differs → mints a fresh twin for the right person', async () => {
    academyTrainersResult = [{ trainer_profile_id: 't1' }];
    // The ONLY guest with this shared family email is the CHILD "Sofie de Vries" — the parent
    // "Mark de Vries" is the registered player being added. Single match, but a different human.
    emailLookupResults = [[{ id: 'child-sofie', full_name: 'Sofie de Vries' }]];
    insertResult = { data: { id: 'new-twin-mark' }, error: null };
    const id = await resolveOrCreateGuestTwinForRegisteredPlayer(
      { kind: 'academy', academyProfileId: 'a1' },
      { profileId: 'p-mark', fullName: 'Mark de Vries', email: 'gezin@x.nl' },
    );
    expect(id).toBe('new-twin-mark');          // fresh twin, NOT Sofie's guest
    expect(insertMock).toHaveBeenCalled();
    // And the child's PII is never patched (we never reused her row).
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('reuses a lone email match when the NAME matches (the real twin)', async () => {
    academyTrainersResult = [{ trainer_profile_id: 't1' }];
    emailLookupResults = [[{ id: 'marks-twin', full_name: 'Mark de Vries' }]];
    const id = await resolveOrCreateGuestTwinForRegisteredPlayer(
      { kind: 'academy', academyProfileId: 'a1' },
      { profileId: 'p-mark', fullName: 'Mark de Vries', email: 'gezin@x.nl' },
    );
    expect(id).toBe('marks-twin');
    expect(insertMock).not.toHaveBeenCalled();
  });
});
