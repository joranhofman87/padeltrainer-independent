import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ComponentProps as ReactComponentProps } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InvoiceSourceCard } from './InvoiceSourceCard';

const fromMock = vi.fn();
const resolveRouteMock = vi.fn();

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: (...args: unknown[]) => fromMock(...args),
  },
}));

vi.mock('@/lib/cyclusPricingRoute', () => ({
  resolveAcademyCyclusPricingRoute: (...args: unknown[]) => resolveRouteMock(...args),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string, opts?: { count?: number }) => {
      const map: Record<string, string> = {
        'invoiceEdit.source.title': 'Source',
        'invoiceEdit.source.type': 'Type',
        'invoiceEdit.source.label': 'Label',
        'invoiceEdit.source.cycle': 'Cycle',
        'invoiceEdit.source.session': 'Session',
        'invoiceEdit.source.multipleSessions': 'Multiple sessions',
        'invoiceEdit.source.sessionCount': `${opts?.count ?? 0} sessions`,
        'invoiceEdit.source.viewCycle': 'View Cycle',
        'invoiceEdit.source.viewSession': 'View Session',
      };
      return map[key] ?? fallback ?? key;
    },
    i18n: { language: 'en' },
  }),
}));

function renderCard(props: ReactComponentProps<typeof InvoiceSourceCard>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <InvoiceSourceCard {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('InvoiceSourceCard', () => {
  beforeEach(() => {
    fromMock.mockReset();
    resolveRouteMock.mockReset();
    resolveRouteMock.mockResolvedValue('/app/academy/cycles/cyc-1');
  });

  it('renders nothing when booking_ids empty', () => {
    const { container } = renderCard({ owner: 'academy', bookingIds: [] });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders cycle source with academy view cycle link', async () => {
    fromMock.mockReturnValue({
      select: () => ({
        in: () =>
          Promise.resolve({
            data: [
              {
                id: 'b1',
                slot_id: 's1',
                availability_slots: {
                  id: 's1',
                  cyclus_id: 'cyc-1',
                  cyclus_name: 'Block A',
                  start_time: '2026-03-01T10:00:00Z',
                },
              },
            ],
            error: null,
          }),
      }),
    });

    renderCard({ owner: 'academy', bookingIds: ['b1'] });

    await waitFor(() => {
      expect(screen.getByText('Cycle')).toBeInTheDocument();
    });
    expect(screen.getByText('Block A')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'View Cycle' })).toHaveAttribute(
        'href',
        '/app/academy/cycles/cyc-1',
      );
    });
  });

  it('renders session source with trainer slot link', async () => {
    fromMock.mockReturnValue({
      select: () => ({
        in: () =>
          Promise.resolve({
            data: [
              {
                id: 'b1',
                slot_id: 'slot-99',
                availability_slots: {
                  id: 'slot-99',
                  cyclus_id: null,
                  cyclus_name: null,
                  start_time: '2026-05-10T09:00:00Z',
                },
              },
            ],
            error: null,
          }),
      }),
    });

    renderCard({ owner: 'trainer', bookingIds: ['b1'] });

    await waitFor(() => {
      expect(screen.getByText('Session')).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: 'View Session' })).toHaveAttribute(
      'href',
      '/app/trainer/slot/slot-99',
    );
    expect(screen.queryByRole('link', { name: 'View Cycle' })).not.toBeInTheDocument();
  });

  it('renders multiple sessions without a single navigation link', async () => {
    fromMock.mockReturnValue({
      select: () => ({
        in: () =>
          Promise.resolve({
            data: [
              {
                id: 'b1',
                slot_id: 's1',
                availability_slots: { id: 's1', cyclus_id: 'c1', cyclus_name: 'A', start_time: '2026-01-01T10:00:00Z' },
              },
              {
                id: 'b2',
                slot_id: 's2',
                availability_slots: { id: 's2', cyclus_id: 'c2', cyclus_name: 'B', start_time: '2026-01-02T10:00:00Z' },
              },
            ],
            error: null,
          }),
      }),
    });

    renderCard({ owner: 'academy', bookingIds: ['b1', 'b2'] });

    await waitFor(() => {
      expect(screen.getByText('Multiple sessions')).toBeInTheDocument();
    });
    expect(screen.getByText('2 sessions')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'View Cycle' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'View Session' })).not.toBeInTheDocument();
  });
});
