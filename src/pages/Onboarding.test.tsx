import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mockRpc = vi.fn();
const mockUpdateProfile = vi.fn();
const mockSetUserRole = vi.fn();
const mockRefreshAuth = vi.fn();
const mockNavigate = vi.fn();

vi.mock('@/lib/supabaseClient', () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args) },
}));

vi.mock('@/lib/auth', () => ({
  setUserRole: (...args: unknown[]) => mockSetUserRole(...args),
  updateProfile: (...args: unknown[]) => mockUpdateProfile(...args),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'user-1' },
    role: null,
    loading: false,
    refreshAuth: mockRefreshAuth,
  }),
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/lib/ratingSystems', () => ({
  getRatingSystems: vi.fn().mockResolvedValue([
    {
      code: 'knltb',
      name: 'KNLTB',
      country: 'nl',
      min_rating: 1,
      max_rating: 9,
      step: 0.1,
      lower_is_better: true,
      member_id_label: null,
      member_id_placeholder: null,
    },
  ]),
  COUNTRY_NAMES: { nl: 'Netherlands' },
  validateRating: () => true,
}));

vi.mock('@/lib/validation', () => ({
  validatePhone: () => null,
}));

vi.mock('@/lib/tracking', () => ({
  trackEvent: vi.fn(),
}));

import Onboarding from './Onboarding';

const renderPlayerOnboarding = () =>
  render(
    <MemoryRouter initialEntries={['/app/onboarding/player']}>
      <Routes>
        <Route path="/app/onboarding/:role" element={<Onboarding />} />
      </Routes>
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
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => store[`session:${key}`] ?? null,
    setItem: (key: string, value: string) => {
      store[`session:${key}`] = value;
    },
    removeItem: (key: string) => {
      delete store[`session:${key}`];
    },
    clear: () => {},
    key: () => null,
    length: 0,
  });
}

describe('Onboarding player flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLocalStorage();
    localStorage.setItem('pendingRole', 'player');
    mockRpc.mockResolvedValue({ data: true, error: null });
    mockUpdateProfile.mockResolvedValue({});
    mockSetUserRole.mockResolvedValue({ user_id: 'user-1', role: 'player' });
    mockRefreshAuth.mockResolvedValue(undefined);
  });

  it('completes player onboarding without calling setUserRole when role already exists', async () => {
    renderPlayerOnboarding();

    await waitFor(() => expect(screen.getByRole('button', { name: /Complete Setup/i })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Complete Setup/i }));

    await waitFor(() => expect(mockRefreshAuth).toHaveBeenCalled());

    expect(mockRpc).toHaveBeenCalledWith('has_role', { _user_id: 'user-1', _role: 'player' });
    expect(mockSetUserRole).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('/app/player');
  });
});
