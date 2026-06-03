import { describe, it, expect } from 'vitest';
import { combineRegistrationFullName, createSignupSchema, splitPrefillFullName } from './signupSchema';

const t = (key: string) => key;

describe('createSignupSchema', () => {
  const schema = createSignupSchema(t);

  it('accepts valid first and last name', () => {
    const result = schema.safeParse({
      firstName: 'Jan',
      lastName: 'Jansen',
      email: 'jan@example.com',
      password: 'password123',
    });
    expect(result.success).toBe(true);
  });

  it('rejects short first name', () => {
    const result = schema.safeParse({
      firstName: 'J',
      lastName: 'Jansen',
      email: 'jan@example.com',
      password: 'password123',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors[0].message).toBe('validation.firstNameRequired');
    }
  });
});

describe('combineRegistrationFullName', () => {
  it('joins first and last name with a space', () => {
    expect(combineRegistrationFullName('Jan', 'Jansen')).toBe('Jan Jansen');
  });

  it('trims parts and collapses extra whitespace', () => {
    expect(combineRegistrationFullName('  Jan  ', '  ')).toBe('Jan');
    expect(combineRegistrationFullName('  ', 'Jansen  ')).toBe('Jansen');
  });
});

describe('splitPrefillFullName', () => {
  it('splits multi-word names', () => {
    expect(splitPrefillFullName('Jan van der Meer')).toEqual({
      firstName: 'Jan',
      lastName: 'van der Meer',
    });
  });

  it('returns single token as first name only', () => {
    expect(splitPrefillFullName('Madonna')).toEqual({ firstName: 'Madonna', lastName: '' });
  });
});
