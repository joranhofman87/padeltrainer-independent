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

import PlayerSignup from './PlayerSignup';
import { signUpWithEmail, signInWithGoogle } from '@/lib/auth';
import { showSignupErrorToast } from '@/lib/signupToast';

const renderPage = (initialEntry = SIGNUP_ROUTES.player) =>
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <PlayerSignup />
    </MemoryRouter>,
  );

describe('PlayerSignup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSignupLocalStorage();
  });

  it('renders structured signup form without legacy fullName field', () => {
    const result = renderPage();
    assertSignupPageStructure('player', result);
    expect(screen.getByTestId('signup-tab-player')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('social.google')).toBeInTheDocument();
  });

  it('renders role tabs with correct links', () => {
    renderPage('/app/signup/player?redirect=%2Ffoo');
    expect(screen.getByTestId('signup-tab-trainer')).toHaveAttribute('href', '/app/signup/trainer?redirect=%2Ffoo');
    expect(screen.getByTestId('signup-tab-club')).toHaveAttribute(
      'href',
      '/app/signup/club?redirect=%2Ffoo',
    );
  });

  it('toggles password visibility', () => {
    renderPage();
    assertPasswordVisibilityToggle();
  });

  it('calls signInWithGoogle when Google button is clicked', async () => {
    (signInWithGoogle as Mock).mockResolvedValue({ error: null });
    renderPage();
    clickGoogleSignup();
    await waitFor(() => expect(signInWithGoogle).toHaveBeenCalled());
  });

  it('shows duplicate-email handling instead of generic signup error', async () => {
    const duplicateError = createSignupFailure(
      SIGNUP_ERROR_CODE.EMAIL_ALREADY_REGISTERED,
      'User already registered',
    );
    (signUpWithEmail as Mock).mockResolvedValue({
      data: { user: null, session: null },
      error: duplicateError,
    });

    renderPage();
    fillValidSignupForm('existing-player@test.com');
    fireEvent.click(screen.getByTestId('btn-signup-submit'));

    await waitFor(() => {
      expect(showSignupErrorToast).toHaveBeenCalled();
      const failure = (showSignupErrorToast as Mock).mock.calls[0][2];
      expect(isSignupEmailAlreadyRegistered(failure)).toBe(true);
    });
    expect(mockToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ description: 'form.signupGenericError' }),
    );
  });
});
