import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import AcademySettings from './AcademySettings';

const checkStatusMock = vi.fn();
const getManagersMock = vi.fn();
const getTrainersMock = vi.fn();

vi.mock('@/lib/academyPayments', () => ({
  checkAcademyConnectStatus: (...args: unknown[]) => checkStatusMock(...args),
  connectAcademyMollie: vi.fn(),
  disconnectAcademyMollie: vi.fn(),
}));

vi.mock('@/lib/academy', () => ({
  getAcademyManagers: (...args: unknown[]) => getManagersMock(...args),
  getAcademyTrainersForManagerPicker: (...args: unknown[]) => getTrainersMock(...args),
  addAcademyManager: vi.fn(),
  removeAcademyManager: vi.fn(),
}));

vi.mock('@/components/academy/AcademyLayout', () => ({
  useAcademyContext: () => ({
    activeAcademy: { id: 'academy-1', name: 'Test Academy', slug: 'test' },
  }),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'user-1' },
    session: null,
    loading: false,
    profile: null,
    role: 'academy',
    roles: ['academy'],
    isClubManager: false,
    isAcademyManager: true,
    subscription: null,
    profileReady: true,
    profileFetchFailed: false,
    refreshAuth: vi.fn(),
    refreshSubscription: vi.fn(),
  }),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useSearchParams: () => [new URLSearchParams()],
  };
});

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('@/components/academy/AcademyPriceDisplayCard', () => ({
  AcademyPriceDisplayCard: () => null,
}));

vi.mock('@/components/settings/DeleteAccountDialog', () => ({
  DeleteAccountDialog: () => null,
}));

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: {}, error: null }),
        }),
      }),
    }),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

vi.mock('@tiptap/react', () => ({
  useEditor: () => null,
  EditorContent: () => null,
}));

describe('AcademySettings Mollie auth gating', () => {
  beforeEach(() => {
    checkStatusMock.mockReset();
    getManagersMock.mockResolvedValue([]);
    getTrainersMock.mockResolvedValue([]);
  });

  it('does not call checkAcademyConnectStatus without session access_token', async () => {
    render(<AcademySettings />);
    await waitFor(() => {
      expect(getManagersMock).toHaveBeenCalled();
    });
    expect(checkStatusMock).not.toHaveBeenCalled();
  });
});
