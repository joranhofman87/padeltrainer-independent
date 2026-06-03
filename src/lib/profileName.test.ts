import { describe, it, expect } from 'vitest';
import {
  buildFullName,
  buildGuestPlayerDbFields,
  getDisplayName,
  getFirstName,
  prefillGuestNameFields,
  resolveGuestNameForInvoice,
  resolveRegistrationNameFields,
  prefillProfileNameFields,
  splitFullName,
} from './profileName';

describe('buildFullName', () => {
  it('joins first and last with trimming', () => {
    expect(buildFullName('  Jan  ', '  de Vries ')).toBe('Jan de Vries');
  });

  it('returns first only when last is empty', () => {
    expect(buildFullName('Madonna', null)).toBe('Madonna');
  });

  it('returns last only when first is empty', () => {
    expect(buildFullName('', 'Smith')).toBe('Smith');
  });

  it('returns empty string for null/empty inputs', () => {
    expect(buildFullName(null, undefined)).toBe('');
    expect(buildFullName('   ', '   ')).toBe('');
  });
});

describe('getDisplayName', () => {
  it('prefers first_name + last_name', () => {
    expect(
      getDisplayName({
        first_name: 'Jan',
        last_name: 'van der Meer',
        full_name: 'Legacy Name',
      }),
    ).toBe('Jan van der Meer');
  });

  it('uses first_name only', () => {
    expect(getDisplayName({ first_name: 'Madonna', full_name: 'Madonna Surname' })).toBe('Madonna');
  });

  it('uses last_name only', () => {
    expect(getDisplayName({ last_name: 'Nguyen', full_name: 'An Nguyen' })).toBe('Nguyen');
  });

  it('falls back to full_name when structured fields are empty', () => {
    expect(getDisplayName({ full_name: 'Jane Coach' })).toBe('Jane Coach');
  });

  it('returns empty string when all fields are empty', () => {
    expect(getDisplayName({})).toBe('');
    expect(getDisplayName({ first_name: null, last_name: '  ', full_name: null })).toBe('');
  });

  it('trims whitespace on structured fields', () => {
    expect(getDisplayName({ first_name: '  Tom  ', last_name: '  Lee  ' })).toBe('Tom Lee');
  });
});

describe('splitFullName', () => {
  it('splits multi-word names', () => {
    expect(splitFullName('Jan van der Meer')).toEqual({
      first_name: 'Jan',
      last_name: 'van der Meer',
    });
  });

  it('returns single token as first_name only', () => {
    expect(splitFullName('Madonna')).toEqual({ first_name: 'Madonna', last_name: '' });
  });
});

describe('buildGuestPlayerDbFields', () => {
  it('writes all three fields on submit', () => {
    expect(buildGuestPlayerDbFields('Jan', 'Jansen')).toEqual({
      first_name: 'Jan',
      last_name: 'Jansen',
      full_name: 'Jan Jansen',
    });
  });

  it('allows last name only via full_name', () => {
    expect(buildGuestPlayerDbFields('', 'Jansen')).toEqual({
      first_name: null,
      last_name: 'Jansen',
      full_name: 'Jansen',
    });
  });
});

describe('prefillGuestNameFields', () => {
  it('uses structured fields when present', () => {
    expect(
      prefillGuestNameFields({
        first_name: 'Jan',
        last_name: 'Meer',
        full_name: 'Legacy',
      }),
    ).toEqual({ first_name: 'Jan', last_name: 'Meer' });
  });

  it('splits full_name when structured fields missing', () => {
    expect(prefillGuestNameFields({ full_name: 'Jane Player' })).toEqual({
      first_name: 'Jane',
      last_name: 'Player',
    });
  });
});

describe('resolveGuestNameForInvoice', () => {
  it('prefers structured guest names', () => {
    expect(
      resolveGuestNameForInvoice({
        first_name: 'Jan',
        last_name: 'Jansen',
        full_name: 'Wrong Legacy',
      }),
    ).toBe('Jan Jansen');
  });

  it('falls back to full_name for legacy guests', () => {
    expect(resolveGuestNameForInvoice({ full_name: 'Legacy Guest' })).toBe('Legacy Guest');
  });
});

describe('getFirstName', () => {
  it('prefers first_name', () => {
    expect(getFirstName({ first_name: 'Jan', full_name: 'Someone Else' })).toBe('Jan');
  });

  it('uses first word of full_name when first_name is missing', () => {
    expect(getFirstName({ full_name: 'Jane Coach' })).toBe('Jane');
  });

  it('handles multi-word full_name fallback', () => {
    expect(getFirstName({ full_name: 'Mary Jane Watson' })).toBe('Mary');
  });

  it('returns empty string when no usable name', () => {
    expect(getFirstName({})).toBe('');
    expect(getFirstName({ full_name: '   ' })).toBe('');
  });

  it('trims first_name', () => {
    expect(getFirstName({ first_name: '  Pieter  ' })).toBe('Pieter');
  });

  it('Dutch particles: structured empty uses first token; display uses full_name', () => {
    const profile = { full_name: 'Jan van der Meer' };
    expect(getFirstName(profile)).toBe('Jan');
    expect(getDisplayName(profile)).toBe('Jan van der Meer');
  });

  it('Dutch particles: after backfill-style structured fields', () => {
    const profile = {
      first_name: 'Jan',
      last_name: 'van der Meer',
      full_name: 'Jan van der Meer',
    };
    expect(getFirstName(profile)).toBe('Jan');
    expect(getDisplayName(profile)).toBe('Jan van der Meer');
  });
});
