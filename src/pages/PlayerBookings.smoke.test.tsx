import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockFrom = vi.fn();

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: (...args: unknown[]) => mockFrom(...args),
  },
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'user-1' },
    profile: { id: 'profile-1' },
    loading: false,
  }),
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('@/hooks/useLocalizedPath', () => ({
  useLocalizedPathFn: () => (path: string) => path,
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => vi.fn() };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => {
      if (key === 'bookings.title') return 'My Bookings';
      if (key === 'bookings.subtitle') return 'Your sessions';
      if (key === 'bookings.tabs.upcoming') return 'Upcoming';
      if (key === 'bookings.tabs.past') return 'Past';
      if (key === 'bookings.invoices') return 'Invoices';
      return fallback ?? key;
    },
  }),
}));

vi.mock('@/lib/lessons', () => ({
  cancelBooking: vi.fn(),
}));

vi.mock('@/lib/reviews', () => ({
  getPlayerReview: vi.fn().mockResolvedValue({ data: null }),
}));

vi.mock('@/components/reviews/ReviewForm', () => ({
  ReviewForm: () => null,
}));

vi.mock('@/components/player/PlayerInvoicesTab', () => ({
  PlayerInvoicesTab: () => <div data-testid="player-invoices-tab-mock" />,
}));

vi.mock('@/components/attendance/PlayerAttendanceForm', () => ({
  PlayerAttendanceForm: () => null,
}));

vi.mock('@/lib/icsGenerator', () => ({
  downloadIcsFile: vi.fn(),
}));

import PlayerBookings from './PlayerBookings';

function chainResolve(data: unknown) {
  const result = Promise.resolve({ data, error: null });
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    neq: () => chain,
    in: () => chain,
    order: () => result,
    maybeSingle: () => result,
  };
  return chain;
}

describe('PlayerBookings smoke', () => {
  beforeEach(() => {
    mockFrom.mockReset();
    mockFrom.mockImplementation((table: string) => {
      if (table === 'bookings') {
        return chainResolve([]);
      }
      if (table === 'trainer_profiles') {
        return chainResolve([]);
      }
      if (table === 'profiles_public') {
        return chainResolve([]);
      }
      if (table === 'invoices') {
        return chainResolve([]);
      }
      return chainResolve([]);
    });
  });

  it('still renders bookings page with invoices tab', async () => {
    render(
      <MemoryRouter>
        <PlayerBookings />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('page-player-bookings')).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'My Bookings' })).toBeInTheDocument();
    });
    expect(screen.getByRole('tab', { name: /Invoices/i })).toBeInTheDocument();
  });
});
