import { describe, expect, it } from 'vitest';
import {
  billingToReceiverFields,
  getAcademyCreateInvoiceUrl,
  getTrainerCreateInvoiceUrl,
  joinBillingAddress,
  parseInvoicePlayerIdParam,
  splitBillingAddress,
  toInvoicePlayerIdParam,
  toTrainerPlayerRouteId,
} from './invoiceCustomer';

describe('parseInvoicePlayerIdParam', () => {
  it('parses guest and profile prefixes', () => {
    expect(parseInvoicePlayerIdParam('g_abc')).toEqual({ kind: 'guest', guestPlayerId: 'abc' });
    expect(parseInvoicePlayerIdParam('p_xyz')).toEqual({ kind: 'profile', profileId: 'xyz' });
    expect(parseInvoicePlayerIdParam('bad')).toBeNull();
    expect(parseInvoicePlayerIdParam(null)).toBeNull();
  });
});

describe('toInvoicePlayerIdParam', () => {
  it('encodes link ids', () => {
    expect(toInvoicePlayerIdParam({ profileId: 'p1', guestPlayerId: null, personId: 'person-p1', linkedDisplayName: null })).toBe(
      'p_p1',
    );
    expect(toInvoicePlayerIdParam({ profileId: null, guestPlayerId: 'g1', personId: 'person-g1', linkedDisplayName: null })).toBe(
      'g_g1',
    );
    expect(toInvoicePlayerIdParam({ profileId: null, guestPlayerId: null, personId: null, linkedDisplayName: null })).toBeNull();
  });
});

describe('billing address helpers', () => {
  it('splits multiline Dutch-style address', () => {
    expect(splitBillingAddress('Main St 1\n1234 AB Amsterdam')).toEqual({
      street: 'Main St 1',
      zipCode: '1234 AB',
      city: 'Amsterdam',
    });
  });

  it('joins address fields', () => {
    expect(joinBillingAddress('Main St 1', '1234 AB', 'Amsterdam')).toBe('Main St 1\n1234 AB Amsterdam');
    expect(joinBillingAddress('', '', '')).toBeNull();
  });

  it('maps billing to receiver fields', () => {
    expect(
      billingToReceiverFields({
        full_name: 'John Doe',
        email: 'john@example.com',
        billing_business_name: 'Acme BV',
        billing_address: 'Street 1\n1234 AB City',
        billing_btw_number: 'NL123',
      }),
    ).toMatchObject({
      playerName: 'John Doe',
      playerEmail: 'john@example.com',
      playerBusinessName: 'Acme BV',
      playerBtwNumber: 'NL123',
      playerStreet: 'Street 1',
      playerZipCode: '1234 AB',
      playerCity: 'City',
    });
  });
});

describe('create invoice URLs', () => {
  it('builds academy and trainer new-invoice links', () => {
    expect(getAcademyCreateInvoiceUrl('g_guest-1')).toBe(
      '/app/academy/invoices/new?playerId=g_guest-1',
    );
    expect(getTrainerCreateInvoiceUrl('p_profile-1')).toBe(
      '/app/trainer/invoices/new?playerId=p_profile-1',
    );
  });
});

describe('toTrainerPlayerRouteId', () => {
  it('maps list rows to route ids', () => {
    expect(
      toTrainerPlayerRouteId({ type: 'guest', id: 'guest-uuid', guest_player_id: 'guest-uuid' }),
    ).toBe('g_guest-uuid');
    expect(toTrainerPlayerRouteId({ type: 'registered', id: 'reg-profile-uuid' })).toBe('p_profile-uuid');
    expect(
      toTrainerPlayerRouteId({ type: 'registered', id: 'x', profile_id: 'profile-uuid' }),
    ).toBe('p_profile-uuid');
  });
});
