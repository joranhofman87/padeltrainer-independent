import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { showSignupErrorToast } from './signupToast';
import { createSignupFailure, SIGNUP_ERROR_CODE } from './signupErrors';

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

describe('showSignupErrorToast', () => {
  const toast = vi.fn();
  const t = (key: string, fallback?: string) => {
    const map: Record<string, string> = {
      'signUp.error': 'Error',
      'form.emailAlreadyRegistered':
        'This email is already registered. Please sign in instead.',
      'form.signupGenericError': 'Something went wrong. Please try again.',
      'signIn.button': 'Sign in',
    };
    return map[key] ?? fallback ?? key;
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows duplicate-email copy and sign-in action', () => {
    showSignupErrorToast(
      toast,
      t,
      createSignupFailure(SIGNUP_ERROR_CODE.EMAIL_ALREADY_REGISTERED, 'User already registered'),
      { component: 'AcademySignup' },
    );

    expect(toast).toHaveBeenCalledTimes(1);
    const props = toast.mock.calls[0][0];
    expect(props.description).toBe(
      'This email is already registered. Please sign in instead.',
    );
    expect(props.variant).toBe('destructive');

    render(<MemoryRouter>{props.action}</MemoryRouter>);
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/app/auth');
  });

  it('shows generic copy for unknown signup errors', () => {
    showSignupErrorToast(
      toast,
      t,
      createSignupFailure(SIGNUP_ERROR_CODE.GENERIC, 'Invalid role'),
      { component: 'ClubSignup' },
    );

    expect(toast.mock.calls[0][0].description).toBe('Something went wrong. Please try again.');
    expect(toast.mock.calls[0][0].action).toBeUndefined();
  });
});
