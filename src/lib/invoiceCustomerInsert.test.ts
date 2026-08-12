import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  buildInvoicePlayerAddress,
  createDraftInvoiceForPerson,
  invoiceRecipientKey,
  resolveInvoicePersonId,
  resolveOrCreateAcademyInvoicePerson,
  resolveOrCreateInvoicePerson,
} from './invoiceCustomerInsert';
import { creationRequestIdFor, clearCreationAttempt, type CreationAttempt } from './creationRequestId';

/**
 * The invoice recipient has no lookup to test and — since the U2 owner correction — no legacy id
 * either. What matters is which arguments reach which command: an operator-picked Player must
 * arrive as a canonical person id and never be re-derived; a hand-typed one must arrive as a create
 * carrying the caller's attempt id; the INSERT must go through the person-keyed server command; and
 * no call may ever pass a name, an address, or a guest id.
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

const lastInvoiceCreate = () =>
  rpcMock.mock.calls.filter((c) => c[0] === 'invoice_create_for_person').at(-1)?.[1] as
    | Record<string, unknown>
    | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  rpcMock.mockImplementation((fn: string) => {
    if (fn === 'player_create_command') {
      return Promise.resolve({ data: { person_id: 'the-person' }, error: null });
    }
    if (fn === 'invoice_create_for_person') {
      return Promise.resolve({
        data: { invoice_id: 'inv-1', invoice_number: 'F-1', person_id: 'the-person' },
        error: null,
      });
    }
    return Promise.resolve({ data: null, error: null });
  });
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

describe('a Player the operator picked travels by canonical id', () => {
  it('returns the linked person id and asks the database nothing', async () => {
    const id = await resolveInvoicePersonId({
      playerLink: { profileId: null, guestPlayerId: 'g1', personId: 'person-g1', linkedDisplayName: 'G' },
      oneTimeMode: false,
      receiver: receiver({ playerName: 'G', playerEmail: 'g@test.com' }),
      scope: 'trainer',
      trainerId: 't1',
      creationRequestId: REQ,
    });
    expect(id).toBe('person-g1');
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('a picked ACCOUNT is the same case: the person id answers, nothing is created', async () => {
    const id = await resolveInvoicePersonId({
      playerLink: { profileId: 'p1', guestPlayerId: null, personId: 'person-p1', linkedDisplayName: 'P' },
      oneTimeMode: false,
      receiver: receiver({ playerName: 'P', playerEmail: 'p@test.com' }),
      scope: 'academy',
      academyProfileId: 'a1',
      creationRequestId: REQ,
    });
    expect(id).toBe('person-p1');
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('the picked id WINS over a receiver naming somebody else entirely', async () => {
    // The regression this guards: re-deriving the recipient from the typed fields, which are stale
    // or belong to a different human whenever the operator edited them after picking.
    const id = await resolveInvoicePersonId({
      playerLink: { profileId: null, guestPlayerId: 'g9', personId: 'the-picked-person', linkedDisplayName: 'Picked' },
      oneTimeMode: false,
      receiver: receiver({ playerName: 'Somebody Else', playerEmail: 'else@test.com' }),
      scope: 'academy',
      academyProfileId: 'a1',
      creationRequestId: REQ,
    });
    expect(id).toBe('the-picked-person');
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('a picked row WITHOUT a person id is a stray: unlinked, logged, never re-created', async () => {
    // Creating a person here would double the human; linking by the legacy id would resurrect the
    // leak. The invoice is saved unlinked — the old resolver's explicit non-blocking contract.
    const id = await resolveInvoicePersonId({
      playerLink: { profileId: null, guestPlayerId: 'stray-guest', personId: null, linkedDisplayName: 'S' },
      oneTimeMode: false,
      receiver: receiver(),
      scope: 'trainer',
      trainerId: 't1',
      creationRequestId: REQ,
    });
    expect(id).toBeNull();
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

describe('a hand-typed recipient is CREATED, never matched', () => {
  it('goes through the command with the caller-supplied attempt id and answers canonically', async () => {
    const id = await resolveInvoicePersonId({
      playerLink: { profileId: null, guestPlayerId: null, personId: null, linkedDisplayName: null },
      oneTimeMode: true,
      receiver: receiver(),
      scope: 'trainer',
      trainerId: 't1',
      creationRequestId: REQ,
    });
    expect(id).toBe('the-person');
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
    await resolveOrCreateInvoicePerson({
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
    const id = await resolveOrCreateAcademyInvoicePerson('Walk-in Wendy', '', 'a1', REQ);
    expect(id).toBe('the-person');
    expect(lastCommand()).toMatchObject({
      _owner_type: 'academy',
      _owner_id: 'a1',
      _full_name: 'Walk-in Wendy',
      _email: null,
    });
  });

  it('returns null without a name — there is nothing to create', async () => {
    expect(await resolveOrCreateAcademyInvoicePerson('   ', 'x@test.com', 'a1', REQ)).toBeNull();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('returns null when the scope owner id is missing', async () => {
    const id = await resolveOrCreateInvoicePerson({
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
    const id = await resolveOrCreateAcademyInvoicePerson('Jan', 'jan@test.com', 'a1', REQ);
    expect(id).toBeNull();
  });
});

describe('the INSERT is the person-keyed server command, and its contract is legacy-free', () => {
  const draftArgs = {
    scope: 'academy' as const,
    ownerId: 'a1',
    personId: 'the-person',
    invoiceNumber: 'F-1',
    invoiceDate: '2026-08-10',
    dueDate: '2026-08-24',
    playerName: 'Sponsor',
    playerBusinessName: null,
    playerAddress: null,
    playerBtwNumber: null,
    lineItems: [] as never,
    subtotal: 10,
    vatRate: 21,
    vatAmount: 2.1,
    vatBreakdown: null,
    total: 12.1,
    pricesIncludeVat: false,
    notes: null,
  };

  it('hands the person id to invoice_create_for_person and touches no table', async () => {
    const out = await createDraftInvoiceForPerson(draftArgs);
    expect(out).toEqual({ invoiceId: 'inv-1' });
    expect(lastInvoiceCreate()).toMatchObject({
      _owner_type: 'academy',
      _owner_id: 'a1',
      _person_id: 'the-person',
      _invoice_number: 'F-1',
    });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('sends no legacy id — there is not even a parameter to put one in', async () => {
    await createDraftInvoiceForPerson(draftArgs);
    const args = lastInvoiceCreate() ?? {};
    expect(Object.keys(args).some((k) => /guest_player|player_id/.test(k))).toBe(false);
  });

  it('a deliberately unlinked one-time invoice passes person NULL, not a fabricated link', async () => {
    await createDraftInvoiceForPerson({ ...draftArgs, personId: null });
    expect(lastInvoiceCreate()?._person_id).toBeNull();
  });

  it('throws the RAW error so the caller\'s collision retry keeps keying on the constraint name', async () => {
    const collision = {
      code: '23505',
      message: 'duplicate key value violates unique constraint "unique_invoice_number_per_academy"',
    };
    rpcMock.mockResolvedValue({ data: null, error: collision });
    await expect(createDraftInvoiceForPerson(draftArgs)).rejects.toBe(collision);
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
