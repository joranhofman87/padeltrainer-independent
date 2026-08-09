import { describe, expect, it, vi, beforeEach } from 'vitest';
import { resolveOrCreateGuestTwinForRegisteredPlayer } from './playerResolve';

/**
 * The roster twin bridge, after U2.
 *
 * The tests this replaces described a resolve-or-create: an email lookup, a name gate, a claim of
 * the matched row, an insert if nothing matched. That whole shape is gone. It was not merely a
 * lookup — the claim STAMPED the matched row with `twin_of_profile_id`, and `mint_person_for_guest`
 * treats that stamp as the explicit operator assertion that authorizes joining the guest's person
 * to the profile's. So an address plus a name became an authorized merge, with no human choosing
 * anything: the roster UI supplies a profile id and nothing else.
 *
 * What is asserted now is that the bridge answers from the profile UUID or creates, and that it
 * never reads an address to decide.
 */
const rpcMock = vi.fn();
const fromMock = vi.fn();
const updateEq = vi.fn().mockResolvedValue({ error: null });

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...(args as [string, Record<string, unknown>])),
    from: (...args: unknown[]) => fromMock(...(args as [string])),
  },
}));

const ACADEMY = 'a1';
const PROFILE = 'p1';

/** The twin lookup answers with this; `undefined` means the bridge RPC itself is unreachable. */
let twinByProfile: string | null | undefined = null;
/** What the create command answers with, or an error to raise. */
let createResult: { guest_player_id: string | null } | null = { guest_player_id: 'twin-new' };
let createError: { code: string; message: string } | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  twinByProfile = null;
  createResult = { guest_player_id: 'twin-new' };
  createError = null;

  rpcMock.mockImplementation((fn: string) => {
    if (fn === 'find_guest_twin_for_academy') {
      return Promise.resolve(
        twinByProfile === undefined
          ? { data: null, error: { message: 'not deployed' } }
          : { data: twinByProfile, error: null },
      );
    }
    if (fn === 'player_create_command') {
      return Promise.resolve(createError ? { data: null, error: createError } : { data: createResult, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });

  fromMock.mockImplementation(() => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'ilike', 'in', 'order', 'limit']) chain[m] = () => chain;
    chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
    chain.update = () => ({ eq: updateEq });
    chain.then = (res: (v: { data: unknown; error: null }) => unknown) =>
      Promise.resolve(res({ data: [], error: null }));
    return chain;
  });
});

const snapshot = (over: Record<string, unknown> = {}) => ({
  profileId: PROFILE,
  fullName: 'Mark Jan Alewijn',
  email: '  MarkJan@Test.COM ',
  ...over,
});

const createCall = () =>
  rpcMock.mock.calls.find((c) => c[0] === 'player_create_command')?.[1] as Record<string, unknown> | undefined;

describe('the twin is found by profile id, or created — never matched on an address', () => {
  it('an existing explicit twin short-circuits: no create, no lookup by anything else', async () => {
    twinByProfile = 'stamped-twin';
    const id = await resolveOrCreateGuestTwinForRegisteredPlayer(
      { kind: 'academy', academyProfileId: ACADEMY },
      snapshot(),
    );
    expect(id).toBe('stamped-twin');
    expect(createCall()).toBeUndefined();
  });

  it('no twin yet: one is CREATED through the command, stamped with the profile id', async () => {
    const id = await resolveOrCreateGuestTwinForRegisteredPlayer(
      { kind: 'academy', academyProfileId: ACADEMY },
      snapshot({ phone: '06', skillRating: 3, ratingSystem: 'NGR', birthDate: '2000-01-01' }),
    );
    expect(id).toBe('twin-new');
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

  it('it can never SELECT an existing Player — the argument that would do that is not sent', async () => {
    await resolveOrCreateGuestTwinForRegisteredPlayer(
      { kind: 'academy', academyProfileId: ACADEMY },
      snapshot(),
    );
    expect(createCall()?._select_person_id).toBeUndefined();
  });

  it('a household address matching an existing guest does NOT claim it', async () => {
    // The removed arm: the matched row would have been stamped as this profile's twin, which is an
    // authorized merge of two people on the strength of a shared address and a name.
    const id = await resolveOrCreateGuestTwinForRegisteredPlayer(
      { kind: 'academy', academyProfileId: ACADEMY },
      snapshot({ fullName: 'Mark Jan Alewijn' }),
    );
    expect(id).toBe('twin-new');
    expect(rpcMock.mock.calls.some((c) => c[0] === 'claim_guest_twin_for_academy')).toBe(false);
  });

  it('a player with NO address still gets a twin', async () => {
    const id = await resolveOrCreateGuestTwinForRegisteredPlayer(
      { kind: 'academy', academyProfileId: ACADEMY },
      snapshot({ email: null }),
    );
    expect(id).toBe('twin-new');
    expect(createCall()?._email).toBeNull();
  });
});

describe('when it cannot answer, it refuses rather than guesses', () => {
  it('an unreachable twin bridge aborts — the caller must not seat the wrong human', async () => {
    twinByProfile = undefined;
    const id = await resolveOrCreateGuestTwinForRegisteredPlayer(
      { kind: 'academy', academyProfileId: ACADEMY },
      snapshot(),
    );
    expect(id).toBeNull();
    expect(createCall()).toBeUndefined();
  });

  it('an unsupported scope aborts instead of falling back to matching', async () => {
    const id = await resolveOrCreateGuestTwinForRegisteredPlayer(
      { kind: 'trainer', trainerId: 't1' },
      snapshot(),
    );
    expect(id).toBeNull();
    expect(createCall()).toBeUndefined();
  });

  it('a player with no name is nothing to create', async () => {
    const id = await resolveOrCreateGuestTwinForRegisteredPlayer(
      { kind: 'academy', academyProfileId: ACADEMY },
      snapshot({ fullName: '   ' }),
    );
    expect(id).toBeNull();
    expect(createCall()).toBeUndefined();
  });

  it('a refused create is a null, not a silently different Player', async () => {
    createError = { code: '42501', message: 'PLAYER_CREATE_FORBIDDEN' };
    const id = await resolveOrCreateGuestTwinForRegisteredPlayer(
      { kind: 'academy', academyProfileId: ACADEMY },
      snapshot(),
    );
    expect(id).toBeNull();
  });

  it('losing a mint race converges on the winner by PROFILE ID, never by address', async () => {
    createError = { code: '23505', message: 'duplicate key value violates uniq_guest_twin_per_academy' };
    let call = 0;
    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'find_guest_twin_for_academy') {
        // the winner's twin is only visible on the re-read, after the race is lost
        return Promise.resolve({ data: call++ === 0 ? null : 'winners-twin', error: null });
      }
      return Promise.resolve({ data: null, error: createError });
    });

    const id = await resolveOrCreateGuestTwinForRegisteredPlayer(
      { kind: 'academy', academyProfileId: ACADEMY },
      snapshot(),
    );
    expect(id).toBe('winners-twin');
  });
});
