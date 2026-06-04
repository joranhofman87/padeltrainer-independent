import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SidebarProvider } from '@/components/ui/sidebar';
import { AcademySidebar } from './AcademySidebar';
import { ACADEMY_PRIMARY_NAV } from './academySidebarNav';

const setOpenMobileMock = vi.fn();
const sidebarTestState = vi.hoisted(() => ({
  isMobile: false,
}));

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => sidebarTestState.isMobile,
}));

vi.mock('@/components/ui/sidebar', async () => {
  const actual = await vi.importActual<typeof import('@/components/ui/sidebar')>('@/components/ui/sidebar');
  const Sidebar = ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="academy-sidebar-shell" className={className}>
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
  Logo: () => <img alt="PadelTrainer.ai" />,
}));

vi.mock('@/components/ReferralWidget', () => ({
  showReferralWidget: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => {
      const labels: Record<string, string> = {
        'nav.dashboard': 'Dashboard',
        'nav.schedule': 'Schedule',
        'nav.players': 'Players',
        'nav.registrations': 'Registrations',
        'nav.invoices': 'Invoices',
        'nav.settings': 'Settings',
        'nav.primary': 'Academy navigation',
        'nav.logout': 'Log out',
        'nav.subscription': 'Subscription',
        'nav.closeMenu': 'Close menu',
        'common.verified': 'Verified',
        badge: 'Academy Manager',
      };
      return labels[key] ?? fallback ?? key;
    },
    i18n: { language: 'en' },
  }),
}));

const mockAcademy = {
  id: 'academy-1',
  name: 'RL Padel',
  slug: 'rl-padel',
  role: 'owner',
  is_verified: true,
  is_public: true,
  logo_url: null,
} as const;

function renderSidebar(initialPath = '/app/academy') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route
          path="/app/academy/*"
          element={
            <SidebarProvider>
              <AcademySidebar academy={mockAcademy} />
            </SidebarProvider>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AcademySidebar desktop', () => {
  beforeEach(() => {
    sidebarTestState.isMobile = false;
    setOpenMobileMock.mockClear();
  });

  it('renders semantic nav with all primary links', () => {
    renderSidebar();

    const nav = screen.getByRole('navigation', { name: 'Academy navigation' });
    expect(nav).toBeInTheDocument();

    for (const item of ACADEMY_PRIMARY_NAV) {
      const link = within(nav).getByTestId(item.testId);
      expect(link).toHaveAttribute('href', item.to);
    }
  });

  it('sets aria-current on the active route', () => {
    renderSidebar('/app/academy/invoices');

    expect(screen.getByRole('link', { name: 'Invoices' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current');
  });

  it('highlights settings when on profile route', () => {
    renderSidebar('/app/academy/profile');

    const settingsLink = screen.getByRole('link', { name: 'Settings' });
    expect(settingsLink).toHaveAttribute('aria-current', 'page');
    expect(settingsLink).toHaveAttribute('href', '/app/academy/settings');
  });

  it('renders account actions in the footer', () => {
    renderSidebar();

    expect(screen.getByTestId('profile-switcher')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log out' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Subscription' })).toBeInTheDocument();
  });
});

describe('AcademySidebar mobile drawer', () => {
  beforeEach(() => {
    sidebarTestState.isMobile = true;
    setOpenMobileMock.mockClear();
  });

  it('closes drawer when a nav link is clicked', async () => {
    renderSidebar('/app/academy');

    fireEvent.click(screen.getByTestId('nav-academy-players'));

    expect(setOpenMobileMock).toHaveBeenCalledWith(false);
  });

  it('closes drawer when close button is pressed', () => {
    renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: 'Close menu' }));

    expect(setOpenMobileMock).toHaveBeenCalledWith(false);
  });
});
