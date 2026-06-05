import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { matchInvoicePrefillPlayer } from './invoiceSelectablePlayers';
import type { InvoiceSelectablePlayer } from './invoiceSelectablePlayers';

const source = readFileSync(resolve(__dirname, 'invoiceSelectablePlayers.ts'), 'utf8');

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

describe('invoice selectable players removal filtering', () => {
  it('filters academy and trainer guests and profiles by removal keys', () => {
    expect(source).toContain('fetchRemovedPlayerKeys');
    expect(source).toContain('filterGuestRowsByRemoval');
    expect(source).toContain('filterProfileIdsByRemoval');
    expect(source).toContain("kind: 'academy'");
    expect(source).toContain("kind: 'trainer'");
  });
});

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
