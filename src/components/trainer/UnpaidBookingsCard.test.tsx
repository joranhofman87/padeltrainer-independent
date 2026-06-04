import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  UnpaidBookingsCard,
  UNPAID_BOOKINGS_PREVIEW_LIMIT,
  getVisibleUnpaidBookings,
} from './UnpaidBookingsCard';
import type { UnpaidBooking } from '@/lib/unpaidBookings';
import { sendEmail } from '@/lib/email';
import { setUnpaidBookingsReminderSent } from '@/lib/unpaidBookings';

const fetchUnpaidBookingsDataMock = vi.fn();
const useQueryOptions: { retry?: boolean }[] = [];

vi.mock('@/lib/unpaidBookings', async () => {
  const actual = await vi.importActual<typeof import('@/lib/unpaidBookings')>('@/lib/unpaidBookings');
  return {
    ...actual,
    fetchUnpaidBookingsData: (...args: unknown[]) => fetchUnpaidBookingsDataMock(...args),
    setUnpaidBookingsReminderSent: vi.fn().mockResolvedValue({ error: null }),
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
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'unpaidBookings.showingCount' && opts) {
        return `Showing ${opts.shown} of ${opts.total}`;
      }
      return key;
    },
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
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));

function makeObligation(index: number): UnpaidBooking {
  return {
    id: `player:p${index}:slot:s${index}`,
    bookingIds: [`b${index}`],
    slotId: `s${index}`,
    playerName: `Player ${index}`,
    playerEmail: `player${index}@example.com`,
    playerId: `p${index}`,
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
  };
}

function renderCard(props: { trainerId?: string; academyId?: string }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 2 } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <UnpaidBookingsCard {...props} />
    </QueryClientProvider>,
  );
}

function countRows() {
  return screen.queryAllByTestId('unpaid-obligation-row').length;
}

describe('getVisibleUnpaidBookings', () => {
  it('returns first 10 when not expanded and more than limit', () => {
    const bookings = Array.from({ length: 12 }, (_, i) => makeObligation(i));
    const visible = getVisibleUnpaidBookings(bookings, false);
    expect(visible).toHaveLength(UNPAID_BOOKINGS_PREVIEW_LIMIT);
    expect(visible[0].playerName).toBe('Player 0');
    expect(visible[9].playerName).toBe('Player 9');
  });

  it('returns all when expanded', () => {
    const bookings = Array.from({ length: 12 }, (_, i) => makeObligation(i));
    expect(getVisibleUnpaidBookings(bookings, true)).toHaveLength(12);
  });
});

describe('UnpaidBookingsCard', () => {
  beforeEach(() => {
    fetchUnpaidBookingsDataMock.mockReset();
    useQueryOptions.length = 0;
    fetchUnpaidBookingsDataMock.mockResolvedValue([]);
    vi.mocked(sendEmail).mockClear();
    vi.mocked(setUnpaidBookingsReminderSent).mockClear();
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
    fetchUnpaidBookingsDataMock.mockResolvedValue([makeObligation(0)]);

    renderCard({ academyId: 'academy-1' });
    await vi.waitFor(() => {
      expect(screen.getByText('Player 0')).toBeInTheDocument();
    });
    expect(screen.getByText('unpaidBookings.title')).toBeInTheDocument();
  });

  it('shows 10 rows initially when 12 unpaid groups exist', async () => {
    fetchUnpaidBookingsDataMock.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => makeObligation(i)),
    );
    renderCard({ academyId: 'academy-1' });
    await vi.waitFor(() => expect(countRows()).toBe(10));
    expect(screen.getByText('Showing 10 of 12')).toBeInTheDocument();
    expect(screen.getByTestId('unpaid-bookings-expand-toggle')).toHaveTextContent(
      'unpaidBookings.showAll',
    );
    expect(screen.queryByText('Player 11')).not.toBeInTheDocument();
  });

  it('shows all rows after Show all is clicked', async () => {
    fetchUnpaidBookingsDataMock.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => makeObligation(i)),
    );
    renderCard({ academyId: 'academy-1' });
    await vi.waitFor(() => expect(countRows()).toBe(10));

    fireEvent.click(screen.getByTestId('unpaid-bookings-expand-toggle'));
    expect(countRows()).toBe(12);
    expect(screen.getByText('Player 11')).toBeInTheDocument();
    expect(screen.getByTestId('unpaid-bookings-expand-toggle')).toHaveTextContent(
      'unpaidBookings.showLess',
    );
  });

  it('collapses to 10 rows after Show less is clicked', async () => {
    fetchUnpaidBookingsDataMock.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => makeObligation(i)),
    );
    renderCard({ academyId: 'academy-1' });
    await vi.waitFor(() => expect(countRows()).toBe(10));

    fireEvent.click(screen.getByTestId('unpaid-bookings-expand-toggle'));
    expect(countRows()).toBe(12);

    fireEvent.click(screen.getByTestId('unpaid-bookings-expand-toggle'));
    expect(countRows()).toBe(10);
    expect(screen.queryByText('Player 11')).not.toBeInTheDocument();
  });

  it('does not show expand control when 10 or fewer obligations', async () => {
    fetchUnpaidBookingsDataMock.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => makeObligation(i)),
    );
    renderCard({ academyId: 'academy-1' });
    await vi.waitFor(() => expect(countRows()).toBe(10));
    expect(screen.queryByTestId('unpaid-bookings-expand-toggle')).not.toBeInTheDocument();
    expect(screen.queryByText(/Showing 10 of/)).not.toBeInTheDocument();
  });

  it('bulk reminder only sends for visible selected rows', async () => {
    fetchUnpaidBookingsDataMock.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => makeObligation(i)),
    );
    renderCard({ academyId: 'academy-1' });
    await vi.waitFor(() => expect(countRows()).toBe(10));

    const header = screen.getByText('unpaidBookings.selectAll').closest('div')?.parentElement;
    expect(header).toBeTruthy();
    const selectAllCheckbox = within(header!).getByRole('checkbox');
    fireEvent.click(selectAllCheckbox);

    fireEvent.click(screen.getByText(/unpaidBookings.sendBulkReminder/));

    await vi.waitFor(() => {
      expect(sendEmail).toHaveBeenCalledTimes(10);
    });
    expect(vi.mocked(setUnpaidBookingsReminderSent)).toHaveBeenCalledTimes(10);
    const remindedIds = vi
      .mocked(setUnpaidBookingsReminderSent)
      .mock.calls.map((c) => c[0])
      .flat();
    expect(remindedIds).toHaveLength(10);
    expect(remindedIds).not.toContain('b11');
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
