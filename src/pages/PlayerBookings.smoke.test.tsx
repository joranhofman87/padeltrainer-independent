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
      if (key === 'bookings.title') return 'My trainings';
      if (key === 'bookings.subtitle') return 'View your upcoming and past trainings';
      if (key === 'bookings.pageGuide') return 'Use the Upcoming and Past tabs';
      if (key === 'bookings.noPastDescription') return 'Completed trainings will appear here after the training date.';
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
  getReviewedBookingIds: vi.fn().mockResolvedValue(new Set()),
}));

vi.mock('@/lib/trainerDisplayNames', () => ({
  fetchTrainerDisplayNamesByProfileIds: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock('@/components/reviews/ReviewForm', () => ({
  ReviewForm: () => null,
}));

vi.mock('@/components/player/PlayerInvoicesTab', () => ({
  PlayerInvoicesTab: () => <div data-testid="player-invoices-tab-mock" />,
}));

vi.mock('@/components/attendance/PlayerSessionReport', () => ({
  PlayerSessionReport: () => null,
}));

vi.mock('@/lib/icsGenerator', () => ({
  downloadIcsFile: vi.fn(),
}));

import PlayerBookings from './PlayerBookings';

function chainResolve(data: unknown) {
  const resolved = { data, error: null };
  const promise = () => Promise.resolve(resolved);
  // Builder methods return the chain; the awaited terminals return real Promises. `.order()` may be
  // terminal (upcoming/all fetch) OR chained into `.range()` (paginated past), so it returns a
  // Promise that also carries a `.range`. Covers upcoming (.gte/.order) + paginated (.not/.range).
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    neq: () => chain,
    in: () => chain,
    not: () => chain,
    gte: () => chain,
    maybeSingle: () => promise(),
    range: () => promise(),
    order: () => Object.assign(promise(), { range: () => promise() }),
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
      expect(screen.getByRole('heading', { name: 'My trainings' })).toBeInTheDocument();
      expect(screen.getByText('Use the Upcoming and Past tabs')).toBeInTheDocument();
    });
    expect(screen.getByRole('tab', { name: /Invoices/i })).toBeInTheDocument();
  });
});
