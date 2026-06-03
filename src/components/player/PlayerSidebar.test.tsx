import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SidebarProvider } from '@/components/ui/sidebar';
import { PlayerSidebar } from './PlayerSidebar';

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

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en' },
  }),
}));

function renderSidebar() {
  return render(
    <MemoryRouter initialEntries={['/app/player']}>
      <SidebarProvider>
        <PlayerSidebar />
      </SidebarProvider>
    </MemoryRouter>,
  );
}

describe('PlayerSidebar', () => {
  it('includes invoices nav link to /app/player/invoices', () => {
    renderSidebar();

    const link = screen.getByTestId('nav-player-invoices');
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/app/player/invoices');
    expect(link.textContent).toMatch(/invoices/i);
  });

  it('keeps bookings nav link', () => {
    renderSidebar();

    const bookings = screen.getByTestId('nav-player-bookings');
    expect(bookings).toHaveAttribute('href', '/app/player/bookings');
  });
});
