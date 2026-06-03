import { describe, it, expect } from 'vitest';
import { buildEditPlayerUpdatePayload } from './EditPlayerDialog';
import { prefillGuestNameFields } from '@/lib/profileName';

describe('buildEditPlayerUpdatePayload', () => {
  it('includes first_name, last_name, and full_name', () => {
    expect(buildEditPlayerUpdatePayload('Jan', 'de Vries')).toEqual({
      first_name: 'Jan',
      last_name: 'de Vries',
      full_name: 'Jan de Vries',
    });
  });
});

describe('EditPlayerDialog prefill', () => {
  it('prefills from structured guest fields', () => {
    expect(
      prefillGuestNameFields({
        first_name: 'Jan',
        last_name: 'Jansen',
        full_name: 'Jan Jansen',
      }),
    ).toEqual({ first_name: 'Jan', last_name: 'Jansen' });
  });

  it('prefills legacy guest from full_name only', () => {
    expect(prefillGuestNameFields({ full_name: 'Legacy Guest Name' })).toEqual({
      first_name: 'Legacy',
      last_name: 'Guest Name',
    });
  });
});
