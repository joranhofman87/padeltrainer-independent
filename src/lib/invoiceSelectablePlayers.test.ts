import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  matchInvoicePrefillPlayer,
  overviewRowToInvoiceSelectablePlayer,
} from './invoiceSelectablePlayers';
import type { InvoiceSelectablePlayer } from './invoiceSelectablePlayers';
import type { PlayersOverviewRow } from './playersOverview';

const sampleGuest: InvoiceSelectablePlayer = {
  comboboxId: 'g_guest-1',
  full_name: 'Guest A',
  email: 'g@test.com',
  phone: '',
  type: 'guest',
  profileId: null,
  guestPlayerId: 'guest-1',
  personId: 'person-g1',
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
  personId: 'person-p1',
  billing_business_name: null,
  billing_address: null,
  billing_btw_number: null,
};

describe('invoice selectable players overview delegation', () => {
  it('builds both fetchers on the players-overview RPC (membership rules live in SQL)', () => {
    const source = readFileSync(resolve(__dirname, 'invoiceSelectablePlayers.ts'), 'utf8');
    expect(source).toContain('fetchAllPlayersOverview');
    expect(source).toContain('searchInvoiceSelectablePlayers');
    expect(source).not.toContain('fetchUnifiedPlayersCore');
    expect(source).not.toContain('filterGuestRowsByRemoval');
  });
});

function overviewRow(overrides: Partial<PlayersOverviewRow>): PlayersOverviewRow {
  return {
    academy_notes: '',
    billing_address: null,
    billing_btw_number: null,
    billing_business_name: null,
    birth_date: null,
    created_at: '2026-01-01T00:00:00Z',
    email: '',
    full_name: '',
    guest_player_id: null,
    has_active_cyclus: false,
    has_overdue_payment: false,
    has_trained: false,
    location_ids: [],
    location_names: [],
    metadata_id: null,
    notes: '',
    owner_trainer_id: null,
    phone: '',
    player_key: '',
    player_type: 'guest',
    person_id: null,
    profile_id: null,
    rating_system: 'knltb',
    skill_rating: null,
    source: 'manual',
    tag_ids: [],
    total_count: 1,
    trainer_ids: [],
    ...overrides,
  } as PlayersOverviewRow;
}

describe('overviewRowToInvoiceSelectablePlayer (server picker search mapping)', () => {
  it('maps a guest row using player_key as comboboxId', () => {
    const row = overviewRow({
      player_key: 'g_guest-1',
      player_type: 'guest',
      guest_player_id: 'guest-1',
      person_id: 'person-g1',
      full_name: 'Guest A',
      email: 'g@test.com',
      phone: '0612345678',
      billing_business_name: 'Padel BV',
      billing_address: 'Street 1\n1234 AB City',
      billing_btw_number: 'NL001',
    });
    expect(overviewRowToInvoiceSelectablePlayer(row)).toEqual({
      comboboxId: 'g_guest-1',
      full_name: 'Guest A',
      email: 'g@test.com',
      phone: '0612345678',
      type: 'guest',
      profileId: null,
      guestPlayerId: 'guest-1',
      personId: 'person-g1',
      billing_business_name: 'Padel BV',
      billing_address: 'Street 1\n1234 AB City',
      billing_btw_number: 'NL001',
    });
  });

  it('maps a registered row with null billing fields', () => {
    const row = overviewRow({
      player_key: 'p_profile-1',
      player_type: 'registered',
      profile_id: 'profile-1',
      person_id: 'person-p1',
      full_name: 'Reg A',
      email: 'r@test.com',
    });
    expect(overviewRowToInvoiceSelectablePlayer(row)).toEqual({
      comboboxId: 'p_profile-1',
      full_name: 'Reg A',
      email: 'r@test.com',
      phone: '',
      type: 'registered',
      profileId: 'profile-1',
      guestPlayerId: null,
      personId: 'person-p1',
      billing_business_name: null,
      billing_address: null,
      billing_btw_number: null,
    });
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
