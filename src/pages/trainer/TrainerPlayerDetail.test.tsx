import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import TrainerPlayerDetail from './TrainerPlayerDetail';

const TRAINER_ID = 'trainer-uuid-1';
const GUEST_ID = 'guest-uuid-1';

const { tableResponses, resolveCycleRouteMock, visibleMock } = vi.hoisted(() => ({
  tableResponses: {} as Record<string, unknown>,
  resolveCycleRouteMock: vi.fn(),
  visibleMock: vi.fn(),
}));

vi.mock('@/lib/trainerPlayerTrainingLocations', () => ({
  fetchTrainerPlayerTrainingLocations: vi.fn().mockResolvedValue([
    { location_id: 'loc-1', location_name: 'Test Club', session_count: 1, last_session_at: null },
  ]),
}));

vi.mock('@/lib/trainerPlayerDetails', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/trainerPlayerDetails')>();
  return {
    ...actual,
    fetchTrainerLocationOptions: vi.fn().mockResolvedValue([{ id: 'loc-1', name: 'Test Club' }]),
  };
});

vi.mock('@/components/trainer/TrainerPlayerDetailsCard', () => ({
  TrainerPlayerDetailsCard: () => <div data-testid="trainer-player-details-card" />,
}));

const guestRow = {
  id: GUEST_ID,
  full_name: 'Jane Guest',
  email: 'jane@example.com',
  phone: null,
  skill_rating: null,
  rating_system: 'knltb',
  notes: null,
  source: null,
  birth_date: null,
  created_at: '2026-01-01T00:00:00Z',
  linked_profile_id: null,
  preferred_location_id: null,
  trainer_id: TRAINER_ID,
};

function mockQueryResult(data: unknown) {
  const resolved = Promise.resolve({ data, error: null });
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    not: () => builder,
    order: () => resolved,
    maybeSingle: () => resolved,
    then: (onFulfilled: (v: { data: unknown; error: null }) => unknown, onRejected?: (e: unknown) => unknown) =>
      resolved.then(onFulfilled, onRejected),
  };
  return builder;
}

vi.mock('@/lib/trainerCyclusPricingRoute', () => ({
  resolveTrainerCyclusPricingRoute: resolveCycleRouteMock,
}));

vi.mock('@/lib/invoiceSelectablePlayers', () => ({
  isTrainerRegisteredPlayerVisible: visibleMock,
}));

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: (table: string) => {
      if (table in tableResponses) {
        return mockQueryResult(tableResponses[table]);
      }
      if (table === 'guest_players') {
        return mockQueryResult(guestRow);
      }
      if (table === 'trainer_profiles') {
        return mockQueryResult({ id: TRAINER_ID });
      }
      if (table === 'academy_player_metadata') {
        return mockQueryResult(null);
      }
      return mockQueryResult([]);
    },
  },
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1' } }),
}));

vi.mock('@/components/players/TagPicker', () => ({
  TagPicker: () => <div data-testid="tag-picker" />,
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string, opts?: Record<string, string>) => {
      if (key === 'players.detail.invoiceSentNumber' && opts?.number) {
        return `Invoice #${opts.number}`;
      }
      const map: Record<string, string> = {
        'players.detail.back': 'Back to players',
        'players.detail.guest': 'Guest',
        'players.detail.registered': 'Registered',
        'players.detail.addedOn': 'Added',
        'players.detail.summary': 'Summary',
        'players.detail.sectionCycles': 'Cycles',
        'players.detail.sectionInvoices': 'Invoices',
        'players.detail.ratingHistory': 'Rating history',
        'players.detail.emailHistory': 'Email history',
        'players.detail.stats.cycles': 'Cycles',
        'players.detail.stats.invoices': 'Invoices',
        'players.detail.stats.ratingPoints': 'Rating points',
        'players.detail.stats.emails': 'Emails',
        'players.detail.singleSessions': 'Single sessions',
        'players.detail.noCycles': 'No cycles joined yet',
        'players.detail.noInvoices': 'No invoices yet',
        'players.detail.noRating': 'No rating history available',
        'players.detail.noEmails': 'No emails sent yet',
        'players.detail.invoiceSent': 'Invoice sent',
        'players.detail.ratingProgress': 'Rating progress',
        'players.detail.ratingGuestHint': 'Rating history is tracked for registered players.',
        'players.detail.createInvoice': 'Create invoice',
        'players.detail.openRecord': 'Open',
        'players.detail.sessions': 'sessions',
      };
      return map[key] ?? fallback ?? key;
    },
  }),
}));

function renderGuestDetail() {
  return render(
    <MemoryRouter initialEntries={[`/app/trainer/players/g_${GUEST_ID}`]}>
      <Routes>
        <Route path="/app/trainer/players/:playerId" element={<TrainerPlayerDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

function getDomIndex(testId: string) {
  const el = screen.getByTestId(testId);
  const all = Array.from(document.body.querySelectorAll('*'));
  return all.indexOf(el);
}

describe('TrainerPlayerDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(tableResponses)) {
      delete tableResponses[key];
    }
    resolveCycleRouteMock.mockResolvedValue('/app/trainer/cycles/cycle-1/edit');
    visibleMock.mockResolvedValue(false);
  });

  it('does not render tabs', async () => {
    renderGuestDetail();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Jane Guest' })).toBeInTheDocument();
    });

    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('renders summary near top before player details', async () => {
    renderGuestDetail();
    await waitFor(() => {
      expect(screen.getByTestId('trainer-player-summary')).toBeInTheDocument();
    });

    expect(getDomIndex('trainer-player-summary')).toBeLessThan(
      getDomIndex('trainer-player-details-card'),
    );
    expect(screen.getByText('Summary')).toBeInTheDocument();
  });

  it('renders content sections directly on the page', async () => {
    renderGuestDetail();
    await waitFor(() => {
      expect(screen.getByTestId('trainer-player-section-cycles')).toBeInTheDocument();
    });

    expect(screen.getByTestId('trainer-player-section-invoices')).toBeInTheDocument();
    expect(screen.getByTestId('trainer-player-section-rating')).toBeInTheDocument();
    expect(screen.getByTestId('trainer-player-section-emails')).toBeInTheDocument();
  });

  it('renders player details card and create invoice button', async () => {
    renderGuestDetail();
    await waitFor(() => {
      expect(screen.getByTestId('trainer-player-details-card')).toBeInTheDocument();
    });

    const createInvoice = screen.getByTestId('trainer-player-create-invoice');
    expect(createInvoice).toHaveAttribute(
      'href',
      `/app/trainer/invoices/new?playerId=${encodeURIComponent(`g_${GUEST_ID}`)}`,
    );
  });

  it('does not render danger zone or delete actions', () => {
    const source = readFileSync(resolve(__dirname, 'TrainerPlayerDetail.tsx'), 'utf8');

    expect(source).not.toContain('RemoveCard');
    expect(source).not.toContain("from('guest_players').delete()");
    expect(source).not.toContain('danger');
  });

  describe('related item navigation', () => {
    beforeEach(() => {
      tableResponses.bookings = [{ id: 'b1', slot_id: 's1', status: 'confirmed' }];
      tableResponses.availability_slots = [
        {
          id: 's1',
          cyclus_id: 'cycle-1',
          cyclus_name: 'Spring Cycle',
          start_time: '2026-01-15T10:00:00Z',
        },
      ];
      tableResponses.invoices = [
        {
          id: 'inv-1',
          invoice_number: 'INV-001',
          invoice_date: '2026-01-01',
          due_date: '2026-01-15',
          total: 100,
          status: 'sent',
          pdf_url: null,
          sent_at: null,
          trainer_id: TRAINER_ID,
        },
      ];
      resolveCycleRouteMock.mockResolvedValue('/app/trainer/cycles/cycle-1/edit');
    });

    it('links cycle rows to trainer cycle pages', async () => {
      renderGuestDetail();
      await waitFor(() => {
        expect(screen.getByTestId('trainer-player-cycle-link-cycle-1')).toBeInTheDocument();
      });

      expect(screen.getByTestId('trainer-player-cycle-link-cycle-1')).toHaveAttribute(
        'href',
        '/app/trainer/cycles/cycle-1/edit',
      );
    });

    it('links invoice rows to trainer invoice edit page', async () => {
      renderGuestDetail();
      await waitFor(() => {
        expect(screen.getByTestId('trainer-player-invoice-link-inv-1')).toBeInTheDocument();
      });

      expect(screen.getByTestId('trainer-player-invoice-link-inv-1')).toHaveAttribute(
        'href',
        '/app/trainer/invoices/inv-1/edit',
      );
    });

    it('shows trainer invoice sent event in email history', async () => {
      tableResponses.invoices = [
        {
          id: 'inv-sent',
          invoice_number: '26000421',
          invoice_date: '2026-01-01',
          due_date: '2026-01-15',
          total: 100,
          status: 'sent',
          pdf_url: null,
          sent_at: '2026-02-01T14:30:00Z',
          trainer_id: TRAINER_ID,
        },
        {
          id: 'inv-other',
          invoice_number: '999',
          invoice_date: '2026-01-02',
          due_date: '2026-01-20',
          total: 50,
          status: 'sent',
          pdf_url: null,
          sent_at: '2026-02-02T10:00:00Z',
          trainer_id: 'other-trainer',
        },
      ];

      renderGuestDetail();
      await waitFor(() => {
        expect(screen.getByTestId('trainer-player-email-invoice-sent-inv-sent')).toBeInTheDocument();
      });

      expect(screen.getByTestId('trainer-player-email-link-invoice-sent-inv-sent')).toHaveAttribute(
        'href',
        '/app/trainer/invoices/inv-sent/edit',
      );
      expect(screen.queryByTestId('trainer-player-email-invoice-sent-inv-other')).not.toBeInTheDocument();
    });
  });
});
