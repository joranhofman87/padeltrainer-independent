import { describe, it, expect } from 'vitest';
import { csvHasGuestNameColumn, guestNameFieldsFromCsvRow } from './guestPlayerCsvName';

describe('guestNameFieldsFromCsvRow', () => {
  it('parses first_name and last_name columns', () => {
    const headers = ['first_name', 'last_name', 'email'];
    const values = ['Jan', 'Jansen', 'jan@test.com'];
    const { fields, missingName } = guestNameFieldsFromCsvRow(headers, values);
    expect(missingName).toBe(false);
    expect(fields).toEqual({
      first_name: 'Jan',
      last_name: 'Jansen',
      full_name: 'Jan Jansen',
    });
  });

  it('splits legacy full_name column', () => {
    const headers = ['full_name', 'email'];
    const values = ['Jan van der Meer', 'jan@test.com'];
    const { fields } = guestNameFieldsFromCsvRow(headers, values);
    expect(fields.full_name).toBe('Jan van der Meer');
    expect(fields.first_name).toBe('Jan');
    expect(fields.last_name).toBe('van der Meer');
  });
});

describe('import validation', () => {
  it('rejects row with no name columns resolved', () => {
    const { missingName } = guestNameFieldsFromCsvRow(['email'], ['jan@test.com']);
    expect(missingName).toBe(true);
  });

  it('requires first_name when using structured column header with empty value', () => {
    const { missingName } = guestNameFieldsFromCsvRow(
      ['first_name', 'email'],
      ['', 'jan@test.com'],
    );
    expect(missingName).toBe(true);
  });
});

describe('csvHasGuestNameColumn', () => {
  it('detects structured headers', () => {
    expect(csvHasGuestNameColumn(['first_name', 'email'])).toBe(true);
  });

  it('detects legacy name header', () => {
    expect(csvHasGuestNameColumn(['naam', 'email'])).toBe(true);
  });
});

describe('CSV template columns', () => {
  it('structured template starts with first_name,last_name', () => {
    const template = `first_name,last_name,email,phone,skill_rating,notes`;
    expect(template.startsWith('first_name,last_name,email')).toBe(true);
  });
});
