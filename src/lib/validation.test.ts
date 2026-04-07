import { describe, it, expect } from 'vitest';
import { validatePhone, formatPhoneNumber, calculatePasswordStrength } from './validation';

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

  // Invalid numbers
  it.each([
    '123',
    '+1 555 1234567',
    'not-a-phone',
    '00000000000',
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

  it('returns fair for 6+ lowercase only', () => {
    const result = calculatePasswordStrength('abcdef');
    expect(result.checks.minLength).toBe(true);
    expect(result.checks.hasLowercase).toBe(true);
    expect(result.checks.hasUppercase).toBe(false);
  });

  it('returns good for mixed case + number', () => {
    const result = calculatePasswordStrength('Abcdef1');
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
