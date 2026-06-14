import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SidebarProvider } from '@/components/ui/sidebar';
import { TrainerSidebar } from './TrainerSidebar';
import { appNavLinkActive } from '@/components/ui/appSidebarStyles';

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
    <div data-testid="trainer-sidebar-shell" className={className} {...props}>
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

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'user-1' },
    profile: { full_name: 'Alex Trainer', avatar_url: null },
  }),
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('@/lib/auth', () => ({
  signOut: vi.fn().mockResolvedValue({ error: null }),
  getTrainerProfile: vi.fn().mockResolvedValue({ id: 'trainer-1', slug: 'alex' }),
}));

vi.mock('@/lib/academy', () => ({
  getTrainerAcademy: vi.fn().mockResolvedValue(null),
}));

// The sidebar reads academy affiliation through this shared hook (useQuery-backed).
// Mock it so the test needs no QueryClient/Supabase and stays deterministic. Default
// is a solo (non-academy) trainer, which is what these nav assertions expect.
const academyTrainerState = vi.hoisted(() => ({ isAcademyTrainer: false }));
vi.mock('@/hooks/useIsAcademyTrainer', () => ({
  useIsAcademyTrainer: () => ({
    isAcademyTrainer: academyTrainerState.isAcademyTrainer,
    isResolved: true,
  }),
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
  'nav.players': 'Players',
  'nav.schedule': 'Schedule',
  'nav.calendar': 'Calendar',
  'nav.agenda': 'Agenda',
  'nav.openSlots': 'Open slots',
  'nav.scheduleOverview': 'Schedule overview',
  'nav.settings': 'Settings',
  'nav.subscription': 'Subscription',
  'nav.earnings': 'Earnings',
  'nav.myProfile': 'My Profile',
  'nav.logout': 'Log out',
  'nav.closeMenu': 'Close menu',
  badge: 'Trainer',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => NAV_LABELS[key] ?? fallback ?? key,
    i18n: { language: 'en' },
  }),
}));

function renderSidebar(path = '/app/trainer') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SidebarProvider>
        <TrainerSidebar />
      </SidebarProvider>
    </MemoryRouter>,
  );
}

describe('TrainerSidebar', () => {
  beforeEach(() => {
    sidebarTestState.isMobile = false;
    setOpenMobileMock.mockClear();
  });

  it('uses new sidebar shell styles', () => {
    renderSidebar();
    expect(screen.getByTestId('trainer-sidebar-shell')).toHaveClass('[&_[data-sidebar=sidebar]]:bg-slate-50');
  });

  it('renders role-specific trainer nav links with /app/trainer paths', async () => {
    renderSidebar();

    expect(await screen.findByTestId('nav-trainer-dashboard')).toHaveAttribute('href', '/app/trainer');
    expect(screen.getByRole('link', { name: 'Players' })).toHaveAttribute('href', '/app/trainer/players');
  });

  it('renders settings link inside business group', () => {
    renderSidebar('/app/trainer/settings');
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/app/trainer/settings');
  });

  it('marks dashboard active on trainer home route', async () => {
    renderSidebar('/app/trainer');

    const dashboard = await screen.findByTestId('nav-trainer-dashboard');
    expect(dashboard).toHaveAttribute('aria-current', 'page');
    expect(dashboard.className).toContain(appNavLinkActive.split(' ')[0]);
  });

  it('renders profile switcher in footer', async () => {
    renderSidebar();
    expect(await screen.findByTestId('profile-switcher')).toBeInTheDocument();
  });
});

describe('TrainerSidebar academy trainer', () => {
  beforeEach(() => {
    sidebarTestState.isMobile = false;
    academyTrainerState.isAcademyTrainer = true;
  });
  afterEach(() => {
    academyTrainerState.isAcademyTrainer = false;
  });

  it('shows only academy-relevant nav and hides financial/business items', async () => {
    renderSidebar('/app/trainer/agenda');

    // Academy mini-nav: the trainer's relevant surfaces.
    expect(await screen.findByRole('link', { name: 'Players' })).toHaveAttribute('href', '/app/trainer/players');
    expect(screen.getByRole('link', { name: 'Agenda' })).toHaveAttribute('href', '/app/trainer/agenda');
    expect(screen.getByRole('link', { name: 'Calendar' })).toHaveAttribute('href', '/app/trainer/calendar');

    // Financial / business surfaces are not in the academy nav (the academy manages them).
    expect(screen.queryByRole('link', { name: 'Earnings' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Subscription' })).toBeNull();
    expect(screen.queryByTestId('nav-trainer-dashboard')).toBeNull();
  });
});

describe('TrainerSidebar mobile drawer', () => {
  beforeEach(() => {
    sidebarTestState.isMobile = true;
    setOpenMobileMock.mockClear();
  });

  it('closes drawer when nav link is clicked', async () => {
    renderSidebar('/app/trainer');

    fireEvent.click(await screen.findByTestId('nav-trainer-dashboard'));
    expect(setOpenMobileMock).toHaveBeenCalledWith(false);
  });

  it('closes drawer when close button is pressed', async () => {
    renderSidebar('/app/trainer');

    fireEvent.click(await screen.findByTestId('trainer-mobile-menu-close'));
    expect(setOpenMobileMock).toHaveBeenCalledWith(false);
  });
});
