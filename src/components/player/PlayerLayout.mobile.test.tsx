import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const setOpenMobileMock = vi.fn();

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => true,
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'user-1' },
    roles: ['player'],
    loading: false,
    profileReady: true,
    profile: { full_name: 'Jan Player' },
  }),
}));

vi.mock('@/components/ReferralWidget', () => ({
  ReferralWidget: () => null,
}));

vi.mock('@/components/player/PlayerSidebar', () => ({
  PlayerSidebar: () => <div data-testid="player-sidebar-stub" />,
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

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

import PlayerLayout from './PlayerLayout';

describe('PlayerLayout mobile', () => {
  beforeEach(() => {
    setOpenMobileMock.mockClear();
  });

  it('opens mobile drawer when menu trigger is clicked', async () => {
    render(
      <MemoryRouter initialEntries={['/app/player']}>
        <PlayerLayout />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByTestId('player-mobile-menu-trigger'));
    expect(setOpenMobileMock).toHaveBeenCalledWith(true);
  });
});
