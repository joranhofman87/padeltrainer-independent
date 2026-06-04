import { describe, it, expect } from 'vitest';
import {
  getAcademyPlayerProfilePath,
  getInvoiceRecipientKind,
  getTrainerPlayerProfilePath,
  getTrainerPlayersListPath,
} from './invoiceRecipient';

describe('invoiceRecipient helpers', () => {
  it('classifies registered player when player_id is set', () => {
    expect(getInvoiceRecipientKind('profile-1', 'guest-1')).toBe('registered');
  });

  it('classifies guest when only guest_player_id is set', () => {
    expect(getInvoiceRecipientKind(null, 'guest-1')).toBe('guest');
  });

  it('classifies manual when neither id is set', () => {
    expect(getInvoiceRecipientKind(null, null)).toBe('manual');
  });

  it('builds academy profile paths', () => {
    expect(getAcademyPlayerProfilePath('p1', null)).toBe('/app/academy/players/p_p1');
    expect(getAcademyPlayerProfilePath(null, 'g1')).toBe('/app/academy/players/g_g1');
    expect(getAcademyPlayerProfilePath(null, null)).toBeNull();
  });

  it('builds trainer players list path when any player id exists', () => {
    expect(getTrainerPlayerProfilePath('p1', null)).toBe('/app/trainer/players/p_p1');
    expect(getTrainerPlayerProfilePath(null, 'g1')).toBe('/app/trainer/players/g_g1');
    expect(getTrainerPlayerProfilePath(null, null)).toBeNull();
    expect(getTrainerPlayersListPath('p1', null)).toBe('/app/trainer/players/p_p1');
  });
});
