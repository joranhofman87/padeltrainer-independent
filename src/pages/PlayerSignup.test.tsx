import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/lib/auth', () => ({
  signUpWithEmail: vi.fn(),
  signInWithGoogle: vi.fn(),
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

import PlayerSignup from './PlayerSignup';

const renderPage = (initialEntry = '/app/signup/player') =>
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <PlayerSignup />
    </MemoryRouter>,
  );

describe('PlayerSignup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders role tabs with player active', () => {
    renderPage();
    expect(screen.getByTestId('signup-tab-player')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('signup-tab-trainer')).toHaveAttribute('href', '/app/signup/trainer');
  });

  it('preserves redirect on role tab links', () => {
    renderPage('/app/signup/player?redirect=%2Ffoo');
    expect(screen.getByTestId('signup-tab-club')).toHaveAttribute(
      'href',
      '/app/signup/club?redirect=%2Ffoo',
    );
  });

  it('toggles password visibility', () => {
    renderPage();
    const passwordInput = screen.getByTestId('input-signup-password');
    expect(passwordInput).toHaveAttribute('type', 'password');

    fireEvent.change(passwordInput, { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: 'form.passwordShow' }));
    expect(passwordInput).toHaveAttribute('type', 'text');
  });
});
