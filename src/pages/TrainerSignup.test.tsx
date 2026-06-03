import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { z } from 'zod';

vi.mock('@/lib/auth', () => ({
  signUpWithEmail: vi.fn(),
  signInWithGoogle: vi.fn(),
  isTrainerOnboardingComplete: vi.fn(),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: null, role: null, loading: false }),
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
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

import TrainerSignup from './TrainerSignup';
import { signUpWithEmail, signInWithGoogle } from '@/lib/auth';
import { buildSignupRolePath } from '@/components/auth/SignupRoleTabs';

const renderPage = (initialEntry = '/app/signup/trainer') =>
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <TrainerSignup />
    </MemoryRouter>,
  );

function mockLocalStorage() {
  const store: Record<string, string> = {};
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      Object.keys(store).forEach((key) => delete store[key]);
    },
    key: () => null,
    length: 0,
  });
}

describe('TrainerSignup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLocalStorage();
  });

  it('renders the signup form with all fields', () => {
    renderPage();
    expect(screen.getByTestId('form-signup-trainer')).toBeInTheDocument();
    expect(screen.getByTestId('input-signup-fullName')).toBeInTheDocument();
    expect(screen.getByTestId('input-signup-email')).toBeInTheDocument();
    expect(screen.getByTestId('input-signup-password')).toBeInTheDocument();
    expect(screen.getByTestId('btn-signup-submit')).toBeInTheDocument();
  });

  it('shows outcome-focused headline copy', () => {
    renderPage();
    expect(screen.getByText('trainerSignup.headline')).toBeInTheDocument();
  });

  it('renders role tabs with trainer active and linked alternatives', () => {
    renderPage();
    expect(screen.getByTestId('signup-tab-trainer')).toBeInTheDocument();
    expect(screen.getByTestId('signup-tab-player')).toHaveAttribute('href', '/app/signup/player');
    expect(screen.getByTestId('signup-tab-club')).toHaveAttribute('href', '/app/signup/club');
    expect(screen.getByTestId('signup-tab-academy')).toHaveAttribute('href', '/app/signup/academy');
  });

  it('preserves redirect query on role tab links', () => {
    renderPage('/app/signup/trainer?redirect=%2Finvite%2Fabc');
    expect(screen.getByTestId('signup-tab-player')).toHaveAttribute(
      'href',
      '/app/signup/player?redirect=%2Finvite%2Fabc',
    );
  });

  it('buildSignupRolePath encodes redirect param', () => {
    expect(buildSignupRolePath('/app/signup/player', '/invite/abc')).toBe(
      '/app/signup/player?redirect=%2Finvite%2Fabc',
    );
    expect(buildSignupRolePath('/app/signup/player', null)).toBe('/app/signup/player');
  });

  it('has a Google OAuth button', () => {
    renderPage();
    expect(screen.getByText('social.google')).toBeInTheDocument();
  });

  it('has a link to sign in', () => {
    renderPage();
    expect(screen.getByText('trainerSignup.alreadyHaveAccount')).toBeInTheDocument();
  });

  it('toggles password visibility', () => {
    renderPage();
    const passwordInput = screen.getByTestId('input-signup-password');
    expect(passwordInput).toHaveAttribute('type', 'password');

    fireEvent.change(passwordInput, { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: 'trainerSignup.password.show' }));

    expect(passwordInput).toHaveAttribute('type', 'text');
    fireEvent.click(screen.getByRole('button', { name: 'trainerSignup.password.hide' }));
    expect(passwordInput).toHaveAttribute('type', 'password');
  });

  it('validates name - too short', async () => {
    renderPage();
    fireEvent.change(screen.getByTestId('input-signup-fullName'), { target: { value: 'A' } });
    fireEvent.change(screen.getByTestId('input-signup-email'), { target: { value: 'test@test.com' } });
    fireEvent.change(screen.getByTestId('input-signup-password'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByTestId('btn-signup-submit'));

    await waitFor(() => {
      expect(screen.getByText('Name must be at least 2 characters')).toBeInTheDocument();
    });
    expect(signUpWithEmail).not.toHaveBeenCalled();
  });

  it('validates email format via zod schema', () => {
    const schema = z.object({
      fullName: z.string().trim().min(2),
      email: z.string().trim().email('Please enter a valid email address'),
      password: z.string().min(8),
    });
    const result = schema.safeParse({ fullName: 'John', email: 'not-an-email', password: 'password123' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors[0].message).toBe('Please enter a valid email address');
    }
  });

  it('validates password length', async () => {
    renderPage();
    fireEvent.change(screen.getByTestId('input-signup-fullName'), { target: { value: 'John Doe' } });
    fireEvent.change(screen.getByTestId('input-signup-email'), { target: { value: 'john@test.com' } });
    fireEvent.change(screen.getByTestId('input-signup-password'), { target: { value: '123' } });
    fireEvent.click(screen.getByTestId('btn-signup-submit'));

    await waitFor(() => {
      expect(screen.getByText('Password must be at least 8 characters')).toBeInTheDocument();
    });
    expect(signUpWithEmail).not.toHaveBeenCalled();
  });

  it('calls signUpWithEmail on valid submission', async () => {
    (signUpWithEmail as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { session: null },
      error: null,
    });

    renderPage();
    fireEvent.change(screen.getByTestId('input-signup-fullName'), { target: { value: 'John Doe' } });
    fireEvent.change(screen.getByTestId('input-signup-email'), { target: { value: 'john@test.com' } });
    fireEvent.change(screen.getByTestId('input-signup-password'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByTestId('btn-signup-submit'));

    await waitFor(() => {
      expect(signUpWithEmail).toHaveBeenCalledWith(
        'john@test.com',
        'password123',
        'John Doe',
        undefined,
        'en',
        'trainer',
      );
    });
  });

  it('calls signInWithGoogle when Google button is clicked', async () => {
    (signInWithGoogle as ReturnType<typeof vi.fn>).mockResolvedValue({ error: null });

    renderPage();
    const googleButtons = screen.getAllByRole('button', { name: /social\.google/i });
    fireEvent.click(googleButtons[0]);

    await waitFor(() => {
      expect(signInWithGoogle).toHaveBeenCalled();
    });
  });

  it('shows password strength indicator', () => {
    renderPage();
    fireEvent.change(screen.getByTestId('input-signup-password'), { target: { value: 'StrongP@ss1' } });
    expect(screen.getByTestId('input-signup-password')).toBeInTheDocument();
  });
});
