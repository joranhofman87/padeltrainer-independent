import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ensureRosterTwinForRegisteredPlayer } from './playerResolve';

/**
 * The roster twin bridge, after the U2 canonical-identity correction.
 *
 * Two generations of behaviour are asserted ABSENT here. The first was the resolve-or-create by
 * address: an email lookup, a name gate, a claim that stamped the matched row — an attribute match
 * laundered into an authorized merge. The second was subtler: the bridge answered with the twin's
 * GUEST id, read out of the create command's result, and patched `has_trained` from the browser —
 * which made a temporary legacy reference part of a client contract.
 *
 * What is asserted now: the bridge creates through the command, answers with CANONICAL identity
 * only, moves the has_trained write server-side, and never reads an address, a table, or a legacy
 * id to decide anything.
 */
const rpcMock = vi.fn();
const fromMock = vi.fn(() => {
  throw new Error('the twin bridge must not query tables directly');
});

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...(args as [string, Record<string, unknown>])),
    from: (...args: unknown[]) => fromMock(...(args as [])),
  },
}));

const ACADEMY = 'a1';
const PROFILE = 'p1';
const PERSON = 'person-1';

/** What the create command answers with, or an error to raise. */
let createResult: { person_id: string | null } | null = { person_id: PERSON };
let createError: { code: string; message: string } | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  createResult = { person_id: PERSON };
  createError = null;

  rpcMock.mockImplementation((fn: string) => {
    if (fn === 'player_create_command') {
      return Promise.resolve(
        createError ? { data: null, error: createError } : { data: createResult, error: null },
      );
    }
    if (fn === 'person_mark_has_trained') {
      return Promise.resolve({ data: true, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });
});

const snapshot = (over: Record<string, unknown> = {}) => ({
  profileId: PROFILE,
  personId: PERSON,
  fullName: 'Mark Jan Alewijn',
  email: '  MarkJan@Test.COM ',
  ...over,
});

const createCall = () =>
  rpcMock.mock.calls.find((c) => c[0] === 'player_create_command')?.[1] as Record<string, unknown> | undefined;
const flagCall = () =>
  rpcMock.mock.calls.find((c) => c[0] === 'person_mark_has_trained')?.[1] as Record<string, unknown> | undefined;

describe('the twin is created through the command, and the answer is canonical identity only', () => {
  it('creates, stamped with the profile id, and answers with the person', async () => {
    const out = await ensureRosterTwinForRegisteredPlayer(
      { kind: 'academy', academyProfileId: ACADEMY },
      snapshot({ phone: '06', skillRating: 3, ratingSystem: 'NGR', birthDate: '2000-01-01' }),
    );
    expect(out).toEqual({ personId: PERSON });
    expect(createCall()).toMatchObject({
      _owner_type: 'academy',
      _owner_id: ACADEMY,
      _full_name: 'Mark Jan Alewijn',
      _email: 'markjan@test.com', // normalized once, on the way in
      _twin_of_profile_id: PROFILE,
      _source: 'roster_registered_twin',
    });
    expect(typeof createCall()?._creation_request_id).toBe('string');
  });

  it('the answer carries NO legacy id — a caller cannot even reach for one', async () => {
    const out = await ensureRosterTwinForRegisteredPlayer(
      { kind: 'academy', academyProfileId: ACADEMY },
      snapshot(),
    );
    expect(Object.keys(out ?? {})).toEqual(['personId']);
  });

  it('has_trained moves server-side: person in, no table touched from the browser', async () => {
    await ensureRosterTwinForRegisteredPlayer(
      { kind: 'academy', academyProfileId: ACADEMY },
      snapshot(),
    );
    expect(flagCall()).toMatchObject({
      _person_id: PERSON,
      _owner_type: 'academy',
      _owner_id: ACADEMY,
    });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('a failed flag write does not lose the seat', async () => {
    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'player_create_command') {
        return Promise.resolve({ data: createResult, error: null });
      }
      return Promise.resolve({ data: null, error: { code: '42501', message: 'nope' } });
    });
    const out = await ensureRosterTwinForRegisteredPlayer(
      { kind: 'academy', academyProfileId: ACADEMY },
      snapshot(),
    );
    expect(out).toEqual({ personId: PERSON });
  });

  it('it can never SELECT an existing Player — the argument that would do that is not sent', async () => {
    await ensureRosterTwinForRegisteredPlayer(
      { kind: 'academy', academyProfileId: ACADEMY },
      snapshot(),
    );
    expect(createCall()?._select_person_id).toBeUndefined();
  });

  it('a household address matching an existing guest does NOT claim it', async () => {
    // The removed arm: the matched row would have been stamped as this profile's twin, which is an
    // authorized merge of two people on the strength of a shared address and a name.
    const out = await ensureRosterTwinForRegisteredPlayer(
      { kind: 'academy', academyProfileId: ACADEMY },
      snapshot({ fullName: 'Mark Jan Alewijn' }),
    );
    expect(out).toEqual({ personId: PERSON });
    expect(rpcMock.mock.calls.some((c) => c[0] === 'claim_guest_twin_for_academy')).toBe(false);
    expect(rpcMock.mock.calls.some((c) => c[0] === 'find_guest_twin_for_academy')).toBe(false);
  });

  it('a player with NO address still gets a twin', async () => {
    const out = await ensureRosterTwinForRegisteredPlayer(
      { kind: 'academy', academyProfileId: ACADEMY },
      snapshot({ email: null }),
    );
    expect(out).toEqual({ personId: PERSON });
    expect(createCall()?._email).toBeNull();
  });
});

describe('when it cannot answer, it refuses rather than guesses', () => {
  it('an unsupported scope aborts instead of falling back to matching', async () => {
    const out = await ensureRosterTwinForRegisteredPlayer(
      { kind: 'trainer', trainerId: 't1' },
      snapshot(),
    );
    expect(out).toBeNull();
    expect(createCall()).toBeUndefined();
  });

  it('a player with no name is nothing to create', async () => {
    const out = await ensureRosterTwinForRegisteredPlayer(
      { kind: 'academy', academyProfileId: ACADEMY },
      snapshot({ fullName: '   ' }),
    );
    expect(out).toBeNull();
    expect(createCall()).toBeUndefined();
  });

  it('a refused create is a null, not a silently different Player', async () => {
    createError = { code: '42501', message: 'PLAYER_CREATE_FORBIDDEN' };
    const out = await ensureRosterTwinForRegisteredPlayer(
      { kind: 'academy', academyProfileId: ACADEMY },
      snapshot(),
    );
    expect(out).toBeNull();
  });

  it('a command that answers without a person is a refusal, not a fabricated id', async () => {
    createResult = { person_id: null };
    const out = await ensureRosterTwinForRegisteredPlayer(
      { kind: 'academy', academyProfileId: ACADEMY },
      snapshot(),
    );
    expect(out).toBeNull();
  });

  it('losing a mint race converges on the person the caller already holds — by B1 the winner merged onto it', async () => {
    createError = { code: '23505', message: 'duplicate key value violates uniq_guest_twin_per_academy' };
    const out = await ensureRosterTwinForRegisteredPlayer(
      { kind: 'academy', academyProfileId: ACADEMY },
      snapshot(),
    );
    expect(out).toEqual({ personId: PERSON });
  });

  it('...and with no person on the picker row, a lost race refuses rather than guessing', async () => {
    createError = { code: '23505', message: 'duplicate key value violates uniq_guest_twin_per_academy' };
    const out = await ensureRosterTwinForRegisteredPlayer(
      { kind: 'academy', academyProfileId: ACADEMY },
      snapshot({ personId: null }),
    );
    expect(out).toBeNull();
  });
});
