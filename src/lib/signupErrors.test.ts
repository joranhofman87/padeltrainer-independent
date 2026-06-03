import { describe, it, expect } from 'vitest';
import {
  SIGNUP_ERROR_CODE,
  isDuplicateEmailSignupMessage,
  normalizeSignupFailure,
  isSignupEmailAlreadyRegistered,
} from './signupErrors';

describe('signupErrors', () => {
  it('detects duplicate email messages', () => {
    expect(isDuplicateEmailSignupMessage('User already registered')).toBe(true);
    expect(isDuplicateEmailSignupMessage('Email already in use')).toBe(true);
    expect(isDuplicateEmailSignupMessage('Invalid role')).toBe(false);
  });

  it('normalizes signup-user JSON body on 4xx invoke', () => {
    const failure = normalizeSignupFailure(
      { message: 'Edge Function returned a non-2xx status code' },
      { error: 'User already registered' },
    );
    expect(failure.code).toBe(SIGNUP_ERROR_CODE.EMAIL_ALREADY_REGISTERED);
    expect(isSignupEmailAlreadyRegistered(failure)).toBe(true);
  });

  it('normalizes duplicate email from response body without invoke message detail', () => {
    const failure = normalizeSignupFailure(null, { error: 'User already registered' });
    expect(failure.code).toBe(SIGNUP_ERROR_CODE.EMAIL_ALREADY_REGISTERED);
  });

  it('returns generic code for unknown signup failures', () => {
    const failure = normalizeSignupFailure(
      { message: 'Network error' },
      { error: 'Invalid role' },
    );
    expect(failure.code).toBe(SIGNUP_ERROR_CODE.GENERIC);
  });
});
