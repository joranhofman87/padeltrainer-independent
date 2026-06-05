import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const setOpenMobileMock = vi.fn();

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => true,
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'user-1' },
    loading: false,
    profileReady: true,
  }),
}));

vi.mock('@/lib/academy', () => ({
  getUserAcademyProfiles: vi.fn().mockResolvedValue([
    { id: 'academy-1', name: 'RL Padel', slug: 'rl', role: 'owner', is_verified: true, is_public: true },
  ]),
}));

vi.mock('@/lib/academySubscription', () => ({
  checkAcademySubscription: vi.fn().mockResolvedValue({ isSubscribed: true, isTrial: false, trialExpired: false }),
  getTrialDaysRemaining: () => 0,
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('@/components/ReferralWidget', () => ({
  ReferralWidget: () => null,
}));

vi.mock('@/components/academy/AcademySidebar', () => ({
  AcademySidebar: () => <div data-testid="academy-sidebar-stub" />,
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    Outlet: () => <div data-testid="outlet" />,
    useNavigate: () => vi.fn(),
  };
});

vi.mock('@/components/ui/sidebar', async () => {
  const actual = await vi.importActual<typeof import('@/components/ui/sidebar')>('@/components/ui/sidebar');
  return {
    ...actual,
    useSidebar: () => ({
      state: 'expanded' as const,
      open: true,
      setOpen: vi.fn(),
      openMobile: false,
      setOpenMobile: setOpenMobileMock,
      isMobile: true,
      toggleSidebar: () => setOpenMobileMock(true),
    }),
  };
});

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');
  return {
    ...actual,
    useQuery: () => ({
      data: { isSubscribed: true, isTrial: false, trialExpired: false },
      refetch: vi.fn(),
    }),
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

describe('AcademyLayout mobile header', () => {
  beforeEach(() => {
    setOpenMobileMock.mockClear();
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
  });

  it('renders mobile menu button with accessible label', async () => {
    const { default: AcademyLayout } = await import('./AcademyLayout');

    render(
      <MemoryRouter initialEntries={['/app/academy']}>
        <AcademyLayout />
      </MemoryRouter>,
    );

    await screen.findByTestId('academy-mobile-menu-trigger');

    const button = screen.getByRole('button', { name: 'Open menu' });
    expect(button).toBeInTheDocument();
  });

  it('opens mobile drawer when menu button is clicked', async () => {
    const { default: AcademyLayout } = await import('./AcademyLayout');

    render(
      <MemoryRouter initialEntries={['/app/academy']}>
        <AcademyLayout />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByTestId('academy-mobile-menu-trigger'));

    expect(setOpenMobileMock).toHaveBeenCalledWith(true);
  });
});
