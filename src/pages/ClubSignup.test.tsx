import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  assertPasswordVisibilityToggle,
  assertSignupPageStructure,
  clickGoogleSignup,
  fillValidSignupForm,
  mockSignupLocalStorage,
  SIGNUP_ROUTES,
} from '@/test/signupPageFreeze';
import { createSignupFailure, SIGNUP_ERROR_CODE, isSignupEmailAlreadyRegistered } from '@/lib/signupErrors';

const mockToast = vi.fn();

vi.mock('@/lib/auth', () => ({
  signUpWithEmail: vi.fn(),
  signInWithGoogle: vi.fn(),
}));

vi.mock('@/lib/signupToast', () => ({
  showSignupErrorToast: vi.fn(),
}));

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: vi.fn(() => ({
      update: vi.fn(() => ({
        eq: vi.fn(() => Promise.resolve({ error: null })),
      })),
    })),
  },
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: null, role: null, loading: false }),
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrParams?: string | Record<string, unknown>) => {
      if (typeof fallbackOrParams === 'string') return fallbackOrParams;
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/lib/tracking', () => ({ trackEvent: vi.fn() }));
vi.mock('@/lib/utm', () => ({ getUtmParams: () => ({}) }));
vi.mock('@/hooks/useHoneypot', () => ({
  useHoneypot: () => ({ honeypotRef: { current: null }, isSuspicious: () => false }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import ClubSignup from './ClubSignup';
import { signUpWithEmail, signInWithGoogle } from '@/lib/auth';
import { showSignupErrorToast } from '@/lib/signupToast';

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={[SIGNUP_ROUTES.club]}>
      <ClubSignup />
    </MemoryRouter>,
  );

describe('ClubSignup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSignupLocalStorage();
  });

  it('renders structured signup form without legacy fullName field', () => {
    const result = renderPage();
    assertSignupPageStructure('club', result);
    expect(screen.getByText('social.google')).toBeInTheDocument();
  });

  it('toggles password visibility', () => {
    renderPage();
    assertPasswordVisibilityToggle();
  });

  it('calls signUpWithEmail with explicit club role parameter', async () => {
    (signUpWithEmail as Mock).mockResolvedValue({
      data: { session: { user: { id: 'user-1' } } },
      error: null,
    });

    renderPage();
    fillValidSignupForm('club-freeze@test.com');
    fireEvent.click(screen.getByTestId('btn-signup-submit'));

    await waitFor(() => {
      expect(signUpWithEmail).toHaveBeenCalledWith(
        'club-freeze@test.com',
        'password123',
        'Alex',
        'Morgan',
        undefined,
        undefined,
        'club',
      );
    });
  });

  it('calls signInWithGoogle when Google button is clicked', async () => {
    (signInWithGoogle as Mock).mockResolvedValue({ error: null });
    renderPage();
    clickGoogleSignup();
    await waitFor(() => expect(signInWithGoogle).toHaveBeenCalled());
  });

  it('shows duplicate-email handling instead of generic signup error', async () => {
    (signUpWithEmail as Mock).mockResolvedValue({
      data: { user: null, session: null },
      error: createSignupFailure(
        SIGNUP_ERROR_CODE.EMAIL_ALREADY_REGISTERED,
        'User already registered',
      ),
    });

    renderPage();
    fillValidSignupForm('existing-club@test.com');
    fireEvent.click(screen.getByTestId('btn-signup-submit'));

    await waitFor(() => {
      expect(showSignupErrorToast).toHaveBeenCalled();
      expect(isSignupEmailAlreadyRegistered((showSignupErrorToast as Mock).mock.calls[0][2])).toBe(
        true,
      );
    });
    expect(mockToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ description: 'form.signupGenericError' }),
    );
  });
});
