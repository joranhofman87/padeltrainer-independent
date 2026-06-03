import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/lib/auth', () => ({
  signUpWithEmail: vi.fn(),
  signInWithGoogle: vi.fn(),
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

import AcademySignup from './AcademySignup';
import { signUpWithEmail } from '@/lib/auth';

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/app/signup/academy']}>
      <AcademySignup />
    </MemoryRouter>,
  );

describe('AcademySignup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls signUpWithEmail with lowercase academy role', async () => {
    (signUpWithEmail as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { session: { user: { id: 'user-1' } } },
      error: null,
    });

    renderPage();
    fireEvent.change(screen.getByTestId('input-signup-firstName'), { target: { value: 'Alex' } });
    fireEvent.change(screen.getByTestId('input-signup-lastName'), { target: { value: 'Smith' } });
    fireEvent.change(screen.getByTestId('input-signup-email'), { target: { value: 'academy@test.com' } });
    fireEvent.change(screen.getByTestId('input-signup-password'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByTestId('btn-signup-submit'));

    await waitFor(() => {
      expect(signUpWithEmail).toHaveBeenCalledWith(
        'academy@test.com',
        'password123',
        'Alex',
        'Smith',
        undefined,
        undefined,
        'academy',
      );
    });
  });
});
