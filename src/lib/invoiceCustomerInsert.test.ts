import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  buildInvoicePlayerAddress,
  invoiceRecipientKey,
  resolveInvoiceGuestPlayerId,
  resolveOrCreateAcademyInvoiceGuest,
  resolveOrCreateInvoiceGuest,
} from './invoiceCustomerInsert';
import { creationRequestIdFor, clearCreationAttempt, type CreationAttempt } from './creationRequestId';

/**
 * The invoice recipient no longer has a lookup to test. It has a COMMAND, and what matters is which
 * arguments reach it: an operator-picked Player must arrive as an id and never be re-derived, a
 * hand-typed one must arrive as a create carrying the caller's attempt id, and no call may ever
 * pass a name or an address as something to search by.
 */
const rpcMock = vi.fn();
const fromMock = vi.fn(() => {
  throw new Error('invoice recipient resolution must not query tables directly');
});

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: (...args: unknown[]) => fromMock(...(args as [])),
    rpc: (...args: unknown[]) => rpcMock(...(args as [string, Record<string, unknown>])),
  },
}));

const REQ = '11111111-1111-4111-8111-111111111111';

const receiver = (over: Partial<Record<string, string>> = {}) => ({
  playerName: 'Sponsor',
  playerEmail: 'sponsor@corp.com',
  playerBusinessName: '',
  playerStreet: '',
  playerZipCode: '',
  playerCity: '',
  playerBtwNumber: '',
  ...over,
});

const lastCommand = () =>
  rpcMock.mock.calls.filter((c) => c[0] === 'player_create_command').at(-1)?.[1] as
    | Record<string, unknown>
    | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  rpcMock.mockResolvedValue({ data: { person_id: 'the-person', guest_player_id: 'new-guest' }, error: null });
});

describe('buildInvoicePlayerAddress', () => {
  it('joins street zip and city', () => {
    expect(
      buildInvoicePlayerAddress({
        playerName: 'A',
        playerBusinessName: '',
        playerStreet: 'St 1',
        playerZipCode: '1234 AB',
        playerCity: 'City',
        playerBtwNumber: '',
        playerEmail: '',
      }),
    ).toBe('St 1\n1234 AB City');
  });
});

describe('a Player the operator picked travels by id', () => {
  it('returns the linked guest id and asks the database nothing', async () => {
    const id = await resolveInvoiceGuestPlayerId({
      playerLink: { profileId: null, guestPlayerId: 'g1', linkedDisplayName: 'G' },
      oneTimeMode: false,
      receiver: receiver({ playerName: 'G', playerEmail: 'g@test.com' }),
      scope: 'trainer',
      trainerId: 't1',
      creationRequestId: REQ,
    });
    expect(id).toBe('g1');
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('a picked ACCOUNT resolves to no guest row and creates nothing', async () => {
    const id = await resolveInvoiceGuestPlayerId({
      playerLink: { profileId: 'p1', guestPlayerId: null, linkedDisplayName: 'P' },
      oneTimeMode: false,
      receiver: receiver({ playerName: 'P', playerEmail: 'p@test.com' }),
      scope: 'academy',
      academyProfileId: 'a1',
      creationRequestId: REQ,
    });
    expect(id).toBeNull();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('the picked id WINS over a receiver naming somebody else entirely', async () => {
    // The regression this guards: re-deriving the recipient from the typed fields, which are stale
    // or belong to a different human whenever the operator edited them after picking.
    const id = await resolveInvoiceGuestPlayerId({
      playerLink: { profileId: null, guestPlayerId: 'the-picked-one', linkedDisplayName: 'Picked' },
      oneTimeMode: false,
      receiver: receiver({ playerName: 'Somebody Else', playerEmail: 'else@test.com' }),
      scope: 'academy',
      academyProfileId: 'a1',
      creationRequestId: REQ,
    });
    expect(id).toBe('the-picked-one');
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

describe('a hand-typed recipient is CREATED, never matched', () => {
  it('goes through the command with the caller-supplied attempt id', async () => {
    const id = await resolveInvoiceGuestPlayerId({
      playerLink: { profileId: null, guestPlayerId: null, linkedDisplayName: null },
      oneTimeMode: true,
      receiver: receiver(),
      scope: 'trainer',
      trainerId: 't1',
      creationRequestId: REQ,
    });
    expect(id).toBe('new-guest');
    expect(lastCommand()).toMatchObject({
      _creation_request_id: REQ,
      _owner_type: 'trainer',
      _owner_id: 't1',
      _full_name: 'Sponsor',
      _email: 'sponsor@corp.com',
      _origin: 'operator',
    });
  });

  it('never passes anything that could SELECT an existing person', async () => {
    await resolveOrCreateInvoiceGuest({
      playerName: 'Jan',
      playerEmail: 'jan@test.com',
      scope: 'academy',
      academyProfileId: 'a1',
      creationRequestId: REQ,
    });
    // `_select_person_id` is the only argument that can name an existing Player, and a typed
    // recipient is by definition not one the operator identified.
    expect(lastCommand()?._select_person_id).toBeUndefined();
  });

  it('creates an emailless Player so invoice-only people appear in the list', async () => {
    const id = await resolveOrCreateAcademyInvoiceGuest('Walk-in Wendy', '', 'a1', REQ);
    expect(id).toBe('new-guest');
    expect(lastCommand()).toMatchObject({
      _owner_type: 'academy',
      _owner_id: 'a1',
      _full_name: 'Walk-in Wendy',
      _email: null,
    });
  });

  it('returns null without a name — there is nothing to create', async () => {
    expect(await resolveOrCreateAcademyInvoiceGuest('   ', 'x@test.com', 'a1', REQ)).toBeNull();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('returns null when the scope owner id is missing', async () => {
    const id = await resolveOrCreateInvoiceGuest({
      playerName: 'Jan',
      playerEmail: 'jan@test.com',
      scope: 'trainer',
      creationRequestId: REQ,
    });
    expect(id).toBeNull();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('a refused command is non-blocking: null, and the invoice is still the operator\'s to save', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'PLAYER_CREATE_FORBIDDEN', code: '42501' } });
    const id = await resolveOrCreateAcademyInvoiceGuest('Jan', 'jan@test.com', 'a1', REQ);
    expect(id).toBeNull();
  });
});

describe('the attempt id is stable across a retry and fresh across an edit', () => {
  const ref: { current: CreationAttempt } = { current: null };
  const keyFor = (playerName: string, playerEmail: string) =>
    invoiceRecipientKey({ playerName, playerEmail, scope: 'academy', ownerId: 'a1' });

  beforeEach(() => {
    ref.current = null;
  });

  it('the same recipient saved twice replays ONE attempt', () => {
    const first = creationRequestIdFor(ref, keyFor('Jan', 'jan@test.com'));
    const retry = creationRequestIdFor(ref, keyFor('Jan', 'jan@test.com'));
    expect(retry).toBe(first);
  });

  it('editing the recipient makes it honestly a different attempt', () => {
    // Otherwise a corrected typo re-submits under an id the server has already bound to the old
    // payload, and the command refuses the save as an idempotency conflict.
    const first = creationRequestIdFor(ref, keyFor('Jan', 'jan@test.com'));
    const edited = creationRequestIdFor(ref, keyFor('Jan Jansen', 'jan@test.com'));
    expect(edited).not.toBe(first);
  });

  it('after a successful save the next invoice is a new attempt', () => {
    const first = creationRequestIdFor(ref, keyFor('Jan', 'jan@test.com'));
    clearCreationAttempt(ref);
    expect(creationRequestIdFor(ref, keyFor('Jan', 'jan@test.com'))).not.toBe(first);
  });
});
