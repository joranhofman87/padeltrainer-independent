import { describe, expect, it } from 'vitest';
import { matchInvoicePrefillPlayer } from './invoiceSelectablePlayers';
import type { InvoiceSelectablePlayer } from './invoiceSelectablePlayers';

const sampleGuest: InvoiceSelectablePlayer = {
  comboboxId: 'g_guest-1',
  full_name: 'Guest A',
  email: 'g@test.com',
  phone: '',
  type: 'guest',
  profileId: null,
  guestPlayerId: 'guest-1',
  billing_business_name: null,
  billing_address: null,
  billing_btw_number: null,
};

const sampleRegistered: InvoiceSelectablePlayer = {
  comboboxId: 'p_profile-1',
  full_name: 'Reg A',
  email: 'r@test.com',
  phone: '',
  type: 'registered',
  profileId: 'profile-1',
  guestPlayerId: null,
  billing_business_name: null,
  billing_address: null,
  billing_btw_number: null,
};

describe('matchInvoicePrefillPlayer (scoped prefill)', () => {
  it('returns guest from selectable list only', () => {
    expect(
      matchInvoicePrefillPlayer([sampleGuest], { kind: 'guest', guestPlayerId: 'guest-1' }),
    ).toEqual(sampleGuest);
    expect(
      matchInvoicePrefillPlayer([sampleGuest], { kind: 'guest', guestPlayerId: 'other' }),
    ).toBeNull();
  });

  it('returns registered profile from selectable list only', () => {
    expect(
      matchInvoicePrefillPlayer([sampleRegistered], { kind: 'profile', profileId: 'profile-1' }),
    ).toEqual(sampleRegistered);
    expect(
      matchInvoicePrefillPlayer([sampleRegistered], { kind: 'profile', profileId: 'foreign' }),
    ).toBeNull();
  });
});
