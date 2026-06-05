import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SidebarProvider } from '@/components/ui/sidebar';
import { AdminSidebar } from './AdminSidebar';

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
    <div data-testid="admin-sidebar-shell" className={className} {...props}>
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

vi.mock('@/hooks/useAdminData', () => ({
  usePendingClaimsCount: () => ({ data: 2 }),
}));

vi.mock('@/lib/auth', () => ({
  signOut: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/components/ThemeToggle', () => ({
  ThemeToggle: () => null,
}));

vi.mock('@/components/Logo', () => ({
  Logo: () => <span>Logo</span>,
}));

const NAV_LABELS: Record<string, string> = {
  panelTitle: 'Admin Panel',
  logout: 'Log out',
  'sidebar.dashboard': 'Dashboard',
  'sidebar.users': 'Users',
  'sidebar.playerRatings': 'Player ratings',
  'sidebar.trainers': 'Trainers',
  'sidebar.academies': 'Academies',
  'sidebar.registrations': 'Registrations',
  'sidebar.locations': 'Locations',
  'sidebar.allLocations': 'All locations',
  'sidebar.verifiedClubs': 'Verified clubs',
  'sidebar.clubClaims': 'Club claims',
  'sidebar.blogArticles': 'Blog articles',
  'sidebar.topicsQueue': 'Topics queue',
  'sidebar.courtReviews': 'Court reviews',
  'sidebar.settings': 'Settings',
  'sidebar.certifications': 'Certifications',
  'sidebar.ratingSystems': 'Rating systems',
  'sidebar.reviewTags': 'Review tags',
  'sidebar.pricingPlans': 'Pricing plans',
  'sidebar.onboardingEmails': 'Onboarding emails',
  'sidebar.backups': 'Backups',
  'nav.closeMenu': 'Close menu',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => NAV_LABELS[key] ?? fallback ?? key,
  }),
}));

function renderSidebar(path = '/app/admin') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SidebarProvider>
        <AdminSidebar />
      </SidebarProvider>
    </MemoryRouter>,
  );
}

describe('AdminSidebar', () => {
  beforeEach(() => {
    sidebarTestState.isMobile = false;
    setOpenMobileMock.mockClear();
  });

  it('uses new sidebar shell styles', () => {
    renderSidebar();
    expect(screen.getByTestId('admin-sidebar-shell')).toHaveClass('[&_[data-sidebar=sidebar]]:bg-slate-50');
  });

  it('renders admin nav links', () => {
    renderSidebar();

    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/app/admin');
    expect(screen.getByRole('link', { name: 'Users' })).toHaveAttribute('href', '/app/admin/users');
    expect(screen.getByRole('link', { name: 'Academies' })).toHaveAttribute('href', '/app/admin/academies');
  });

  it('renders pricing link inside settings group', () => {
    renderSidebar('/app/admin/pricing');
    expect(screen.getByRole('link', { name: 'Pricing plans' })).toHaveAttribute('href', '/app/admin/pricing');
  });

  it('marks users active on users route', () => {
    renderSidebar('/app/admin/users');
    expect(screen.getByRole('link', { name: 'Users' })).toHaveAttribute('aria-current', 'page');
  });
});

describe('AdminSidebar mobile drawer', () => {
  beforeEach(() => {
    sidebarTestState.isMobile = true;
    setOpenMobileMock.mockClear();
  });

  it('closes drawer when nav link is clicked', () => {
    renderSidebar('/app/admin');

    fireEvent.click(screen.getByRole('link', { name: 'Users' }));
    expect(setOpenMobileMock).toHaveBeenCalledWith(false);
  });

  it('closes drawer when close button is pressed', () => {
    renderSidebar('/app/admin');

    fireEvent.click(screen.getByTestId('admin-mobile-menu-close'));
    expect(setOpenMobileMock).toHaveBeenCalledWith(false);
  });
});
