import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { getOnboardingRouteForSignupRole, type SignupRole } from '@/lib/auth';

const mockCompleteOAuthSignup = vi.fn();
const mockRefreshAuth = vi.fn();
const mockNavigate = vi.fn();

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    signInWithEmail: vi.fn(),
    signInWithGoogle: vi.fn(),
    isTrainerOnboardingComplete: vi.fn(),
    completeOAuthSignup: (...args: unknown[]) => mockCompleteOAuthSignup(...args),
  };
});

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
    from: () => ({
      select: () => ({
        eq: () => ({
          limit: () => Promise.resolve({ data: [], error: null }),
        }),
      }),
    }),
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
    </MemoryRouter>,
  );

const storage: Record<string, string> = {};

function setupOAuthNewUser(pendingRole: SignupRole) {
  localStorage.setItem('pendingRole', pendingRole);
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
}

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
    (signInWithEmail as Mock).mockResolvedValue({ error: null });

    renderPage();
    fireEvent.change(screen.getByTestId('auth-email-input'), { target: { value: 'user@test.com' } });
    fireEvent.change(screen.getByTestId('auth-password-input'), { target: { value: 'mypassword' } });
    fireEvent.click(screen.getByTestId('auth-login-button'));

    await waitFor(() => {
      expect(signInWithEmail).toHaveBeenCalledWith('user@test.com', 'mypassword');
    });
  });

  it('calls signInWithGoogle when Google button clicked', async () => {
    (signInWithGoogle as Mock).mockResolvedValue({ error: null });

    renderPage();
    fireEvent.click(screen.getByTestId('auth-google-button'));

    await waitFor(() => {
      expect(signInWithGoogle).toHaveBeenCalled();
    });
  });

  it.each(['player', 'trainer', 'club', 'academy'] as const)(
    'completes OAuth signup for pendingRole=%s and routes to onboarding',
    async (pendingRole) => {
      setupOAuthNewUser(pendingRole);
      renderPage();

      await waitFor(() => {
        expect(mockCompleteOAuthSignup).toHaveBeenCalledWith(pendingRole);
        expect(mockNavigate).toHaveBeenCalledWith(getOnboardingRouteForSignupRole(pendingRole));
      });
      expect(localStorage.getItem('pendingRole')).toBeNull();
    },
  );

  it('disables login button while loading', async () => {
    (signInWithEmail as Mock).mockImplementation(() => new Promise(() => {}));

    renderPage();
    fireEvent.change(screen.getByTestId('auth-email-input'), { target: { value: 'user@test.com' } });
    fireEvent.change(screen.getByTestId('auth-password-input'), { target: { value: 'pass' } });
    fireEvent.click(screen.getByTestId('auth-login-button'));

    await waitFor(() => {
      expect(screen.getByTestId('auth-login-button')).toBeDisabled();
    });
  });
});
