import { describe, it, expect } from 'vitest';
import {
  buildGuestPlayerDbFields,
  prefillProfileNameFields,
  resolveRegistrationNameFields,
} from './profileName';

describe('registration guest name persistence', () => {
  it('resolves structured names for submit-guest-intake body', () => {
    const fields = resolveRegistrationNameFields({
      firstName: 'Jane',
      lastName: 'Player',
      fullName: 'ignored legacy',
    });
    expect(fields).toEqual({
      first_name: 'Jane',
      last_name: 'Player',
      full_name: 'Jane Player',
    });
  });

  it('splits legacy fullName when structured names absent', () => {
    const fields = resolveRegistrationNameFields({ fullName: 'Jan van der Meer' });
    expect(fields.first_name).toBe('Jan');
    expect(fields.last_name).toBe('van der Meer');
    expect(fields.full_name).toBe('Jan van der Meer');
  });

  it('rejects empty registration names', () => {
    expect(resolveRegistrationNameFields({})).toEqual({
      first_name: null,
      last_name: null,
      full_name: '',
    });
  });

  it('buildGuestPlayerDbFields matches registration combine', () => {
    expect(buildGuestPlayerDbFields('Jan', 'Jansen')).toEqual(
      resolveRegistrationNameFields({ firstName: 'Jan', lastName: 'Jansen' }),
    );
  });
});

describe('logged-in registration prefill', () => {
  it('prefers profile first_name and last_name', () => {
    expect(
      prefillProfileNameFields({
        first_name: 'Alex',
        last_name: 'Morgan',
        full_name: 'Legacy Full',
      }),
    ).toEqual({ first_name: 'Alex', last_name: 'Morgan' });
  });

  it('falls back to split full_name when structured fields missing', () => {
    expect(prefillProfileNameFields({ full_name: 'Jane Player' })).toEqual({
      first_name: 'Jane',
      last_name: 'Player',
    });
  });
});
