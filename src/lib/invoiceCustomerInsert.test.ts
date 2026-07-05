import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  buildInvoicePlayerAddress,
  findExistingGuestPlayerIdForInvoice,
  resolveInvoiceGuestPlayerId,
  resolveOrCreateAcademyInvoiceGuest,
  resolveOrCreateInvoiceGuest,
} from './invoiceCustomerInsert';

const insertMock = vi.fn();
let guestLookupResult: { id: string; full_name?: string | null } | null = null;

// The email lookup selects 'id, full_name' as a LIST (shared emails allowed).
function chainable(resolved?: unknown) {
  const value =
    resolved ?? { data: guestLookupResult ? [guestLookupResult] : [], error: null };
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    or: () => builder,
    in: () => builder,
    limit: () => builder,
    order: () => builder,
    maybeSingle: () => Promise.resolve(value),
    single: () => Promise.resolve(value),
    then: (
      onFulfilled: (v: { data: unknown; error: null }) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => Promise.resolve(value).then(onFulfilled, onRejected),
  };
  return builder;
}

const fromMock = vi.fn((table: string) => {
  if (table === 'guest_players') {
    return {
      ...chainable(),
      insert: insertMock,
    };
  }
  if (table === 'academy_trainers') {
    return chainable({ data: [], error: null });
  }
  return chainable();
});

// P2-2: the academy email-dedup branch now routes through the SECURITY DEFINER RPC
// find_guest_players_by_email_for_academy (so dedup still sees trainer-owned candidates
// even though the direct academy SELECT is now relationship-scoped). Return the same
// candidate list the direct email query would, driven by guestLookupResult.
const rpcMock = vi.fn((fn: string) => {
  if (fn === 'find_guest_players_by_email_for_academy') {
    return Promise.resolve({ data: guestLookupResult ? [guestLookupResult] : [], error: null });
  }
  return Promise.resolve({ data: null, error: null });
});

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: (...args: unknown[]) => fromMock(...args),
    rpc: (...args: unknown[]) => rpcMock(...(args as [string])),
  },
}));

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

describe('findExistingGuestPlayerIdForInvoice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guestLookupResult = { id: 'existing-by-email' };
  });

  it('reuses trainer-scoped guest by email', async () => {
    const id = await findExistingGuestPlayerIdForInvoice('dup@test.com', 'trainer', undefined, 't1');
    expect(id).toBe('existing-by-email');
    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe('resolveInvoiceGuestPlayerId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guestLookupResult = null;
    insertMock.mockReturnValue({
      select: () => ({
        single: () => Promise.resolve({ data: { id: 'new-guest' }, error: null }),
      }),
    });
  });

  it('returns linked guest id without insert', async () => {
    const id = await resolveInvoiceGuestPlayerId({
      playerLink: { profileId: null, guestPlayerId: 'g1', linkedDisplayName: 'G' },
      oneTimeMode: false,
      receiver: {
        playerName: 'G',
        playerEmail: 'g@test.com',
        playerBusinessName: '',
        playerStreet: '',
        playerZipCode: '',
        playerCity: '',
        playerBtwNumber: '',
      },
      scope: 'trainer',
      trainerId: 't1',
    });
    expect(id).toBe('g1');
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('returns null for registered profile link', async () => {
    const id = await resolveInvoiceGuestPlayerId({
      playerLink: { profileId: 'p1', guestPlayerId: null, linkedDisplayName: 'P' },
      oneTimeMode: false,
      receiver: {
        playerName: 'P',
        playerEmail: 'p@test.com',
        playerBusinessName: '',
        playerStreet: '',
        playerZipCode: '',
        playerCity: '',
        playerBtwNumber: '',
      },
      scope: 'academy',
      academyProfileId: 'a1',
    });
    expect(id).toBeNull();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('reuses existing guest by email instead of inserting duplicate', async () => {
    guestLookupResult = { id: 'existing-by-email' };
    const id = await resolveInvoiceGuestPlayerId({
      playerLink: { profileId: null, guestPlayerId: null, linkedDisplayName: null },
      oneTimeMode: true,
      receiver: {
        playerName: 'Sponsor',
        playerEmail: 'sponsor@corp.com',
        playerBusinessName: '',
        playerStreet: '',
        playerZipCode: '',
        playerCity: '',
        playerBtwNumber: '',
      },
      scope: 'trainer',
      trainerId: 't1',
    });
    expect(id).toBe('existing-by-email');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('creates guest for one-time customer with email when none exists', async () => {
    const id = await resolveInvoiceGuestPlayerId({
      playerLink: { profileId: null, guestPlayerId: null, linkedDisplayName: null },
      oneTimeMode: true,
      receiver: {
        playerName: 'Sponsor',
        playerEmail: 'sponsor@corp.com',
        playerBusinessName: 'Corp',
        playerStreet: '',
        playerZipCode: '',
        playerCity: '',
        playerBtwNumber: '',
      },
      scope: 'trainer',
      trainerId: 't1',
    });
    expect(id).toBe('new-guest');
    expect(fromMock).toHaveBeenCalledWith('guest_players');
  });

  it('creates an emailless guest for a manual recipient with a name', async () => {
    const id = await resolveInvoiceGuestPlayerId({
      playerLink: { profileId: null, guestPlayerId: null, linkedDisplayName: null },
      oneTimeMode: true,
      receiver: {
        playerName: 'Walk-in',
        playerEmail: '',
        playerBusinessName: '',
        playerStreet: '',
        playerZipCode: '',
        playerCity: '',
        playerBtwNumber: '',
      },
      scope: 'trainer',
      trainerId: 't1',
    });
    expect(id).toBe('new-guest');
    expect(insertMock).toHaveBeenCalledTimes(1);
    const insertArg = insertMock.mock.calls[0][0];
    expect(insertArg.trainer_id).toBe('t1');
    expect(insertArg.full_name).toBe('Walk-in');
    expect(insertArg.email).toBeUndefined();
  });

  it('returns null when name and email are both empty', async () => {
    const id = await resolveInvoiceGuestPlayerId({
      playerLink: { profileId: null, guestPlayerId: null, linkedDisplayName: null },
      oneTimeMode: true,
      receiver: {
        playerName: '   ',
        playerEmail: '',
        playerBusinessName: '',
        playerStreet: '',
        playerZipCode: '',
        playerCity: '',
        playerBtwNumber: '',
      },
      scope: 'trainer',
      trainerId: 't1',
    });
    expect(id).toBeNull();
    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe('resolveOrCreateInvoiceGuest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guestLookupResult = null;
    insertMock.mockReturnValue({
      select: () => ({
        single: () => Promise.resolve({ data: { id: 'new-guest' }, error: null }),
      }),
    });
  });

  it('creates an emailless trainer-scoped guest', async () => {
    const id = await resolveOrCreateInvoiceGuest({
      playerName: 'Cash Customer',
      playerEmail: '',
      scope: 'trainer',
      trainerId: 't1',
    });
    expect(id).toBe('new-guest');
    const insertArg = insertMock.mock.calls[0][0];
    expect(insertArg.trainer_id).toBe('t1');
    expect(insertArg.email).toBeUndefined();
  });

  it('dedupes by email within academy scope', async () => {
    guestLookupResult = { id: 'existing-by-email' };
    const id = await resolveOrCreateInvoiceGuest({
      playerName: 'Jan',
      playerEmail: 'jan@test.com',
      scope: 'academy',
      academyProfileId: 'a1',
    });
    expect(id).toBe('existing-by-email');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('returns null when the scope owner id is missing', async () => {
    const id = await resolveOrCreateInvoiceGuest({
      playerName: 'Jan',
      playerEmail: 'jan@test.com',
      scope: 'trainer',
    });
    expect(id).toBeNull();
    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe('resolveOrCreateAcademyInvoiceGuest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guestLookupResult = null;
    insertMock.mockReturnValue({
      select: () => ({
        single: () => Promise.resolve({ data: { id: 'new-guest' }, error: null }),
      }),
    });
  });

  it('returns null when no name is given (nothing to create)', async () => {
    const id = await resolveOrCreateAcademyInvoiceGuest('   ', 'x@test.com', 'a1');
    expect(id).toBeNull();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('dedupes by email within academy scope instead of inserting', async () => {
    guestLookupResult = { id: 'existing-by-email' };
    const id = await resolveOrCreateAcademyInvoiceGuest('Jan', 'jan@test.com', 'a1');
    expect(id).toBe('existing-by-email');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('creates an academy guest with email when none exists', async () => {
    guestLookupResult = null;
    const id = await resolveOrCreateAcademyInvoiceGuest('Jan', 'jan@test.com', 'a1');
    expect(id).toBe('new-guest');
    expect(insertMock).toHaveBeenCalledTimes(1);
  });

  it('still creates an emailless player so invoice-only people appear in the list', async () => {
    const id = await resolveOrCreateAcademyInvoiceGuest('Walk-in Wendy', '', 'a1');
    expect(id).toBe('new-guest');
    expect(insertMock).toHaveBeenCalledTimes(1);
    const insertArg = insertMock.mock.calls[0][0];
    expect(insertArg.academy_profile_id).toBe('a1');
    expect(insertArg.full_name).toBe('Walk-in Wendy');
    expect(insertArg.email).toBeUndefined();
  });
});
