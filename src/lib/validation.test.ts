import { describe, it, expect } from 'vitest';
import {
  validatePhone,
  formatPhoneNumber,
  calculatePasswordStrength,
  createOptionalPhoneSchema,
} from './validation';

describe('validatePhone', () => {
  // Valid Dutch numbers
  it.each([
    '0612345678',
    '06-1234-5678',
    '06 1234 5678',
    '+31612345678',
    '+31 6 12345678',
    '0031612345678',
    '0031 6 12345678',
    '0201234567',
  ])('accepts valid Dutch number: %s', (phone) => {
    expect(validatePhone(phone)).toBeNull();
  });

  // International numbers (E.164-ish +CC) are accepted — booking players are
  // not all Dutch; only 0-prefixed local numbers must look Dutch.
  it.each([
    '+1 555 1234567',
    '+49 170 1234567',
    '+34612345678',
    '+44 7911 123456',
  ])('accepts international number: %s', (phone) => {
    expect(validatePhone(phone)).toBeNull();
  });

  // Invalid numbers
  it.each([
    '123',
    'not-a-phone',
    '00000000000',
    '+1 23',            // too short after country code
    '+1234567890123456', // too long (>15 digits)
    '0123',              // 0-prefixed must be a full Dutch number
  ])('rejects invalid number: %s', (phone) => {
    expect(validatePhone(phone)).toBe('validation.phoneInvalid');
  });

  it('returns null for empty string when not required', () => {
    expect(validatePhone('')).toBeNull();
    expect(validatePhone('  ')).toBeNull();
  });

  it('returns error for empty string when required', () => {
    expect(validatePhone('', true)).toBe('validation.phoneRequired');
    expect(validatePhone('  ', true)).toBe('validation.phoneRequired');
  });
});

describe('createOptionalPhoneSchema', () => {
  const schema = createOptionalPhoneSchema('Invalid phone');

  it('accepts empty phone', () => {
    expect(schema.safeParse('').success).toBe(true);
    expect(schema.safeParse('   ').success).toBe(true);
  });

  it('accepts valid Dutch phone', () => {
    expect(schema.safeParse('+31612345678').success).toBe(true);
  });

  it('rejects invalid phone when provided', () => {
    const result = schema.safeParse('not-a-phone');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors[0].message).toBe('Invalid phone');
    }
  });
});

describe('formatPhoneNumber', () => {
  it('formats +31 mobile number', () => {
    expect(formatPhoneNumber('+31612345678')).toBe('+31 6 1234 5678');
  });

  it('formats 0031 number', () => {
    expect(formatPhoneNumber('0031612345678')).toBe('+31 6 1234 5678');
  });

  it('formats 06 number', () => {
    expect(formatPhoneNumber('0612345678')).toBe('06 1234 5678');
  });

  it('formats landline number', () => {
    expect(formatPhoneNumber('0201234567')).toBe('020 123 4567');
  });

  it('returns input unchanged for unrecognized format', () => {
    expect(formatPhoneNumber('12345')).toBe('12345');
  });
});

describe('calculatePasswordStrength', () => {
  it('returns weak for short password', () => {
    const result = calculatePasswordStrength('abc');
    expect(result.level).toBe('weak');
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.checks.minLength).toBe(false);
  });

  it('meets min length at 8+ characters (lowercase only)', () => {
    const result = calculatePasswordStrength('abcdefgh');
    expect(result.checks.minLength).toBe(true);
    expect(result.checks.hasLowercase).toBe(true);
    expect(result.checks.hasUppercase).toBe(false);
  });

  it('returns good for mixed case + number at 8+ characters', () => {
    const result = calculatePasswordStrength('Abcdef12');
    expect(result.score).toBeGreaterThanOrEqual(3);
    expect(result.level).toBe('good');
  });

  it('returns strong for full complexity', () => {
    const result = calculatePasswordStrength('Abcdef1!xyz');
    expect(result.score).toBe(4);
    expect(result.level).toBe('strong');
  });

  it('caps score at 4', () => {
    const result = calculatePasswordStrength('Abcdefgh1!@#');
    expect(result.score).toBeLessThanOrEqual(4);
  });
});
