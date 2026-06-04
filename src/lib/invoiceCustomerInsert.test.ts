import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  buildInvoicePlayerAddress,
  findExistingGuestPlayerIdForInvoice,
  resolveInvoiceGuestPlayerId,
} from './invoiceCustomerInsert';

const insertMock = vi.fn();
let guestLookupResult: { id: string } | null = null;

function chainable(resolved: unknown = { data: guestLookupResult, error: null }) {
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    or: () => builder,
    in: () => builder,
    limit: () => builder,
    order: () => resolved,
    maybeSingle: () => Promise.resolve(resolved),
    single: () => Promise.resolve(resolved),
    then: (
      onFulfilled: (v: { data: unknown; error: null }) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => Promise.resolve(resolved).then(onFulfilled, onRejected),
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

vi.mock('@/lib/supabaseClient', () => ({
  supabase: { from: (...args: unknown[]) => fromMock(...args) },
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

  it('returns null when no email for manual recipient', async () => {
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
    expect(id).toBeNull();
    expect(fromMock).not.toHaveBeenCalled();
  });
});
