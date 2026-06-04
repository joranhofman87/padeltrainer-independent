import { describe, expect, it } from 'vitest';
import type { InvoicePlayerLink } from './invoiceCustomer';

/** Mirrors AcademyCreateInvoice / TrainerCreateInvoice insert linkage fields. */
function resolveInvoiceInsertLinkage(
  oneTimeMode: boolean,
  playerLink: InvoicePlayerLink,
  guestPlayerId: string | null,
) {
  return {
    player_id: oneTimeMode ? null : playerLink.profileId,
    guest_player_id: guestPlayerId,
  };
}

describe('invoice create linkage (academy & trainer)', () => {
  const guestLink: InvoicePlayerLink = {
    profileId: null,
    guestPlayerId: 'guest-1',
    linkedDisplayName: 'Guest User',
  };

  const registeredLink: InvoicePlayerLink = {
    profileId: 'profile-1',
    guestPlayerId: null,
    linkedDisplayName: 'Reg User',
  };

  it('registered player sets player_id only', () => {
    expect(resolveInvoiceInsertLinkage(false, registeredLink, null)).toEqual({
      player_id: 'profile-1',
      guest_player_id: null,
    });
  });

  it('guest player sets guest_player_id only', () => {
    expect(resolveInvoiceInsertLinkage(false, guestLink, 'guest-1')).toEqual({
      player_id: null,
      guest_player_id: 'guest-1',
    });
  });

  it('one-time customer clears player_id even when link was set', () => {
    expect(resolveInvoiceInsertLinkage(true, registeredLink, 'new-guest-id')).toEqual({
      player_id: null,
      guest_player_id: 'new-guest-id',
    });
  });

  it('one-time without email has no player_id and optional guest', () => {
    expect(resolveInvoiceInsertLinkage(true, guestLink, null)).toEqual({
      player_id: null,
      guest_player_id: null,
    });
  });
});
