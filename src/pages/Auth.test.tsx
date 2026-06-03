import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockCompleteOAuthSignup = vi.fn();
const mockRefreshAuth = vi.fn();
const mockNavigate = vi.fn();

vi.mock('@/lib/auth', () => ({
  signInWithEmail: vi.fn(),
  signInWithGoogle: vi.fn(),
  isTrainerOnboardingComplete: vi.fn(),
  completeOAuthSignup: (...args: unknown[]) => mockCompleteOAuthSignup(...args),
  getOnboardingRouteForSignupRole: (role: string) =>
    role === 'academy' ? '/app/academy/onboarding' : `/app/onboarding/${role}`,
  isSignupRole: (value: string) => ['player', 'trainer', 'club', 'academy'].includes(value),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

let mockAuthState = {
  user: null as { id: string } | null,
  role: null as string | null,
  loading: false,
  profileReady: false,
  profileFetchFailed: false,
  isAcademyManager: false,
  isClubManager: false,
};

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    ...mockAuthState,
    refreshAuth: mockRefreshAuth,
  }),
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback || key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    auth: { setSession: vi.fn().mockResolvedValue({ error: null }) },
    from: () => ({ select: () => ({ eq: () => ({ limit: () => ({ data: [], error: null }) }) }) }),
  },
}));

vi.mock('@/lib/tracking', () => ({ trackEvent: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import Auth from './Auth';
import { signInWithEmail, signInWithGoogle } from '@/lib/auth';

const renderPage = () =>
  render(
    <MemoryRouter>
      <Auth />
    </MemoryRouter>
  );

const storage: Record<string, string> = {};

describe('Auth (Login Page)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(storage).forEach((k) => delete storage[k]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage[key] ?? null,
      setItem: (key: string, value: string) => {
        storage[key] = value;
      },
      removeItem: (key: string) => {
        delete storage[key];
      },
      clear: () => {
        Object.keys(storage).forEach((k) => delete storage[k]);
      },
    });
    mockAuthState = {
      user: null,
      role: null,
      loading: false,
      profileReady: false,
      profileFetchFailed: false,
      isAcademyManager: false,
      isClubManager: false,
    };
  });

  it('renders login form with email and password inputs', () => {
    renderPage();
    expect(screen.getByTestId('form-login')).toBeInTheDocument();
    expect(screen.getByTestId('auth-email-input')).toBeInTheDocument();
    expect(screen.getByTestId('auth-password-input')).toBeInTheDocument();
    expect(screen.getByTestId('auth-login-button')).toBeInTheDocument();
  });

  it('renders Google OAuth button', () => {
    renderPage();
    expect(screen.getByTestId('auth-google-button')).toBeInTheDocument();
  });

  it('has forgot password link', () => {
    renderPage();
    expect(screen.getByText('Forgot password?')).toBeInTheDocument();
  });

  it('has sign up link', () => {
    renderPage();
    expect(screen.getByText('Sign up')).toBeInTheDocument();
  });

  it('has back to home link', () => {
    renderPage();
    expect(screen.getByText('Back to home')).toBeInTheDocument();
  });

  it('calls signInWithEmail on form submission', async () => {
    (signInWithEmail as ReturnType<typeof vi.fn>).mockResolvedValue({ error: null });

    renderPage();
    fireEvent.change(screen.getByTestId('auth-email-input'), { target: { value: 'user@test.com' } });
    fireEvent.change(screen.getByTestId('auth-password-input'), { target: { value: 'mypassword' } });
    fireEvent.click(screen.getByTestId('auth-login-button'));

    await waitFor(() => {
      expect(signInWithEmail).toHaveBeenCalledWith('user@test.com', 'mypassword');
    });
  });

  it('calls signInWithGoogle when Google button clicked', async () => {
    (signInWithGoogle as ReturnType<typeof vi.fn>).mockResolvedValue({ error: null });

    renderPage();
    fireEvent.click(screen.getByTestId('auth-google-button'));

    await waitFor(() => {
      expect(signInWithGoogle).toHaveBeenCalled();
    });
  });

  it('completes OAuth signup and routes academy to academy onboarding', async () => {
    localStorage.setItem('pendingRole', 'academy');
    mockAuthState = {
      user: { id: 'oauth-user' },
      role: null,
      loading: false,
      profileReady: true,
      profileFetchFailed: false,
      isAcademyManager: false,
      isClubManager: false,
    };
    mockCompleteOAuthSignup.mockResolvedValue({ success: true, error: null });
    mockRefreshAuth.mockResolvedValue(undefined);

    renderPage();

    await waitFor(() => {
      expect(mockCompleteOAuthSignup).toHaveBeenCalledWith('academy');
      expect(mockNavigate).toHaveBeenCalledWith('/app/academy/onboarding');
    });
    expect(localStorage.getItem('pendingRole')).toBeNull();
  });

  it('disables login button while loading', async () => {
    (signInWithEmail as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise(() => {}) // never resolves
    );

    renderPage();
    fireEvent.change(screen.getByTestId('auth-email-input'), { target: { value: 'user@test.com' } });
    fireEvent.change(screen.getByTestId('auth-password-input'), { target: { value: 'pass' } });
    fireEvent.click(screen.getByTestId('auth-login-button'));

    await waitFor(() => {
      expect(screen.getByTestId('auth-login-button')).toBeDisabled();
    });
  });
});
