import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UnpaidBookingsCard } from './UnpaidBookingsCard';

const fetchUnpaidBookingsDataMock = vi.fn();
const useQueryOptions: { retry?: boolean }[] = [];

vi.mock('@/lib/unpaidBookings', async () => {
  const actual = await vi.importActual<typeof import('@/lib/unpaidBookings')>('@/lib/unpaidBookings');
  return {
    ...actual,
    fetchUnpaidBookingsData: (...args: unknown[]) => fetchUnpaidBookingsDataMock(...args),
  };
});

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');
  return {
    ...actual,
    useQuery: (options: { retry?: boolean; queryFn: () => unknown }) => {
      useQueryOptions.push({ retry: options.retry });
      return actual.useQuery(options);
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('@/lib/supabaseClient', () => ({
  supabase: { from: vi.fn() },
}));

vi.mock('@/lib/email', () => ({
  sendEmail: vi.fn(),
}));

function renderCard(props: { trainerId?: string; academyId?: string }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 2 } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <UnpaidBookingsCard {...props} />
    </QueryClientProvider>,
  );
}

describe('UnpaidBookingsCard', () => {
  beforeEach(() => {
    fetchUnpaidBookingsDataMock.mockReset();
    useQueryOptions.length = 0;
    fetchUnpaidBookingsDataMock.mockResolvedValue([]);
  });

  it('uses retry: false for unpaid bookings query', async () => {
    renderCard({ trainerId: 'trainer-1' });
    await vi.waitFor(() => {
      expect(useQueryOptions.some((o) => o.retry === false)).toBe(true);
    });
  });

  it('renders nothing when fetch returns empty (including after errors)', async () => {
    fetchUnpaidBookingsDataMock.mockResolvedValue([]);
    renderCard({ trainerId: 'trainer-1' });
    await vi.waitFor(() => {
      expect(fetchUnpaidBookingsDataMock).toHaveBeenCalled();
    });
    expect(screen.queryByText('unpaidBookings.title')).not.toBeInTheDocument();
  });

  it('renders unpaid bookings when data is returned', async () => {
    fetchUnpaidBookingsDataMock.mockResolvedValue([
      {
        id: 'player:p1:slot:s1',
        bookingIds: ['b1'],
        slotId: 's1',
        playerName: 'Alex',
        playerEmail: 'alex@example.com',
        playerId: 'p1',
        guestPlayerId: null,
        sessionDate: '10 Jun 2026',
        sessionTime: '10:00 - 11:00',
        amount: 25,
        cyclusName: null,
        cyclusId: null,
        sessionCount: 1,
        isCycleGroup: false,
        reminderSentAt: null,
        trainerName: 'Coach Sam',
      },
    ]);

    renderCard({ academyId: 'academy-1' });
    await vi.waitFor(() => {
      expect(screen.getByText('Alex')).toBeInTheDocument();
    });
    expect(screen.getByText('unpaidBookings.title')).toBeInTheDocument();
  });

  it('does not crash when fetch resolves to empty after failure path', async () => {
    fetchUnpaidBookingsDataMock.mockResolvedValue([]);
    const { container } = renderCard({ trainerId: 'trainer-1' });
    await vi.waitFor(() => {
      expect(fetchUnpaidBookingsDataMock).toHaveBeenCalled();
    });
    expect(container).toBeEmptyDOMElement();
  });
});
