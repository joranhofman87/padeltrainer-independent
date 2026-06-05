import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SidebarProvider } from '@/components/ui/sidebar';
import { ClubSidebar } from './ClubSidebar';

const setOpenMobileMock = vi.fn();
const sidebarTestState = vi.hoisted(() => ({
  isMobile: false,
}));

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => sidebarTestState.isMobile,
}));

vi.mock('@/components/ui/sidebar', async () => {
  const actual = await vi.importActual<typeof import('@/components/ui/sidebar')>('@/components/ui/sidebar');
  const Sidebar = ({ children, className, ...props }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="club-sidebar-shell" className={className} {...props}>
      {children}
    </div>
  );
  return {
    ...actual,
    Sidebar,
    useSidebar: () => ({
      state: 'expanded' as const,
      open: true,
      setOpen: vi.fn(),
      openMobile: true,
      setOpenMobile: setOpenMobileMock,
      isMobile: sidebarTestState.isMobile,
      toggleSidebar: vi.fn(),
    }),
  };
});

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
  'nav.profile': 'Profile',
  'nav.people': 'People',
  'nav.trainers': 'Trainers',
  'nav.players': 'Players',
  'nav.calendar': 'Calendar',
  'nav.registrations': 'Registrations',
  'nav.tournaments': 'Tournaments',
  'nav.settings': 'Settings',
  'nav.subscription': 'Subscription',
  'nav.logout': 'Log out',
  'nav.closeMenu': 'Close menu',
  badge: 'Club Manager',
  'common:verified': 'Verified',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => NAV_LABELS[key] ?? fallback ?? key,
    i18n: { language: 'en' },
  }),
}));

const mockClub = {
  id: 'club-1',
  logo_url: null,
  is_verified: true,
  location: { name: 'Padel Club Amsterdam' },
} as const;

function renderSidebar(path = '/app/club') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SidebarProvider>
        <ClubSidebar club={mockClub} onClubChange={vi.fn()} />
      </SidebarProvider>
    </MemoryRouter>,
  );
}

describe('ClubSidebar', () => {
  beforeEach(() => {
    sidebarTestState.isMobile = false;
    setOpenMobileMock.mockClear();
  });

  it('uses new sidebar shell styles', () => {
    renderSidebar();
    expect(screen.getByTestId('club-sidebar-shell')).toHaveClass('[&_[data-sidebar=sidebar]]:bg-slate-50');
  });

  it('renders club role nav links', () => {
    renderSidebar();

    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/app/club');
    expect(screen.getByRole('link', { name: 'Calendar' })).toHaveAttribute('href', '/app/club/calendar');
    expect(screen.getByRole('link', { name: 'Registrations' })).toHaveAttribute('href', '/app/club/registrations');
  });

  it('renders settings link inside account group', () => {
    renderSidebar('/app/club/settings');
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/app/club/settings');
  });

  it('marks calendar active on calendar route', () => {
    renderSidebar('/app/club/calendar');
    expect(screen.getByRole('link', { name: 'Calendar' })).toHaveAttribute('aria-current', 'page');
  });
});

describe('ClubSidebar mobile drawer', () => {
  beforeEach(() => {
    sidebarTestState.isMobile = true;
    setOpenMobileMock.mockClear();
  });

  it('closes drawer when nav link is clicked', () => {
    renderSidebar('/app/club');

    fireEvent.click(screen.getByRole('link', { name: 'Calendar' }));
    expect(setOpenMobileMock).toHaveBeenCalledWith(false);
  });

  it('closes drawer when close button is pressed', () => {
    renderSidebar('/app/club');

    fireEvent.click(screen.getByTestId('club-mobile-menu-close'));
    expect(setOpenMobileMock).toHaveBeenCalledWith(false);
  });
});
