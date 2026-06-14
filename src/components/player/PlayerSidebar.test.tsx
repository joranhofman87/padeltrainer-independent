import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SidebarProvider } from '@/components/ui/sidebar';
import { PlayerSidebar } from './PlayerSidebar';
import { isPlayerNavItemActive, PLAYER_PRIMARY_NAV } from '@/components/player/playerSidebarNav';

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    profile: { full_name: 'Jan Player', avatar_url: null },
  }),
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('@/lib/auth', () => ({
  signOut: vi.fn().mockResolvedValue({ error: null }),
}));

vi.mock('@/components/ProfileSwitcher', () => ({
  ProfileSwitcher: () => <div data-testid="profile-switcher" />,
}));

vi.mock('@/components/ThemeToggle', () => ({
  ThemeToggle: () => null,
}));

vi.mock('@/components/Logo', () => ({
  Logo: () => <span>Logo</span>,
}));

vi.mock('@/components/ReferralWidget', () => ({
  showReferralWidget: vi.fn(),
}));

const NAV_LABELS: Record<string, string> = {
  'nav.dashboard': 'Dashboard',
  'nav.bookings': 'My trainings',
  'nav.invoices': 'Invoices',
  'nav.profile': 'My Profile',
  'nav.following': 'Trainers I follow',
  'nav.account': 'Account',
  'nav.settings': 'Settings',
  'nav.notifications': 'Notifications',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => NAV_LABELS[key] ?? fallback ?? key,
    i18n: { language: 'en' },
  }),
}));

function renderSidebar(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <SidebarProvider>
          <PlayerSidebar />
        </SidebarProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('PlayerSidebar', () => {
  it('includes invoices and bookings nav links', () => {
    renderSidebar('/app/player');

    expect(screen.getByTestId('nav-player-invoices')).toHaveAttribute('href', '/app/player/invoices');
    expect(screen.getByTestId('nav-player-bookings')).toHaveAttribute('href', '/app/player/bookings');
  });

  it('shows My trainings and Trainers I follow in primary nav', () => {
    renderSidebar('/app/player');

    expect(screen.getByRole('link', { name: 'My trainings' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Trainers I follow' })).toBeInTheDocument();
  });

  it('marks invoices link active on invoices route', () => {
    renderSidebar('/app/player/invoices');

    const link = screen.getByTestId('nav-player-invoices');
    expect(link).toHaveAttribute('aria-current', 'page');
  });

  it('marks dashboard active only on exact dashboard path', () => {
    renderSidebar('/app/player/bookings');
    expect(screen.getByTestId('nav-player-dashboard')).not.toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('nav-player-bookings')).toHaveAttribute('aria-current', 'page');
  });
});

describe('isPlayerNavItemActive', () => {
  it('uses end match for dashboard', () => {
    const dashboard = PLAYER_PRIMARY_NAV.find((i) => i.id === 'dashboard')!;
    expect(isPlayerNavItemActive('/app/player', dashboard)).toBe(true);
    expect(isPlayerNavItemActive('/app/player/bookings', dashboard)).toBe(false);
  });
});
