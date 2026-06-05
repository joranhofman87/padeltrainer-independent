import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import AcademyPlayerDetail from './AcademyPlayerDetail';

const { tableResponses, resolveCycleRouteMock } = vi.hoisted(() => ({
  tableResponses: {} as Record<string, unknown>,
  resolveCycleRouteMock: vi.fn(),
}));

vi.mock('@/lib/academy', () => ({
  getAcademyLocations: vi.fn().mockResolvedValue([
    { location: { id: 'loc-1', name: 'Test Club' } },
  ]),
}));

vi.mock('@/lib/academyPlayerTrainingLocations', () => ({
  fetchPlayerTrainingLocations: vi.fn().mockResolvedValue([
    { location_id: 'loc-1', location_name: 'Test Club', session_count: 1, last_session_at: null },
  ]),
}));

vi.mock('@/components/academy/AcademyPlayerDetailsCard', () => ({
  AcademyPlayerDetailsCard: () => <div data-testid="academy-player-details-card" />,
}));

vi.mock('@/components/academy/AcademyPlayerRemoveCard', () => ({
  AcademyPlayerRemoveCard: () => <div data-testid="academy-player-remove-card" />,
}));

const GUEST_ID = 'guest-uuid-1';
const ACADEMY_ID = 'academy-uuid-1';

const guestRow = {
  id: GUEST_ID,
  full_name: 'Jane Guest',
  email: null,
  phone: null,
  skill_rating: null,
  rating_system: 'knltb',
  notes: null,
  source: null,
  birth_date: null,
  created_at: '2026-01-01T00:00:00Z',
  linked_profile_id: null,
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

vi.mock('@/lib/cyclusPricingRoute', () => ({
  resolveAcademyCyclusPricingRoute: resolveCycleRouteMock,
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
      if (table === 'academy_player_metadata') {
        return mockQueryResult(null);
      }
      return mockQueryResult([]);
    },
  },
}));

vi.mock('@/components/academy/AcademyLayout', () => ({
  useAcademyContext: () => ({
    activeAcademy: { id: ACADEMY_ID, name: 'Test Academy' },
  }),
}));

vi.mock('@/components/players/TagPicker', () => ({
  TagPicker: () => <div data-testid="tag-picker" />,
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => {
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
    <MemoryRouter initialEntries={[`/app/academy/players/g_${GUEST_ID}`]}>
      <Routes>
        <Route path="/app/academy/players/:playerId" element={<AcademyPlayerDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

function getDomIndex(testId: string) {
  const el = screen.getByTestId(testId);
  const all = Array.from(document.body.querySelectorAll('*'));
  return all.indexOf(el);
}

describe('AcademyPlayerDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(tableResponses)) {
      delete tableResponses[key];
    }
    resolveCycleRouteMock.mockResolvedValue('/app/academy/cycles/cycle-1');
  });

  it('does not render tabs', async () => {
    renderGuestDetail();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Jane Guest' })).toBeInTheDocument();
    });

    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.queryByText('Overview')).not.toBeInTheDocument();
  });

  it('renders summary near top before player details', async () => {
    renderGuestDetail();
    await waitFor(() => {
      expect(screen.getByTestId('academy-player-summary')).toBeInTheDocument();
    });

    expect(getDomIndex('academy-player-summary')).toBeLessThan(
      getDomIndex('academy-player-details-card'),
    );
    expect(screen.getByText('Summary')).toBeInTheDocument();
    expect(screen.getAllByText('Cycles').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Invoices').length).toBeGreaterThanOrEqual(1);
  });

  it('renders content sections directly on the page', async () => {
    renderGuestDetail();
    await waitFor(() => {
      expect(screen.getByTestId('academy-player-section-cycles')).toBeInTheDocument();
    });

    expect(screen.getByTestId('academy-player-section-invoices')).toBeInTheDocument();
    expect(screen.getByTestId('academy-player-section-rating')).toBeInTheDocument();
    expect(screen.getByTestId('academy-player-section-emails')).toBeInTheDocument();
    expect(screen.getByText('Rating history')).toBeInTheDocument();
    expect(screen.getByText('Email history')).toBeInTheDocument();
  });

  it('renders empty states for sections without data', async () => {
    renderGuestDetail();
    await waitFor(() => {
      expect(screen.getByText('No cycles joined yet')).toBeInTheDocument();
    });

    expect(screen.getByText('No invoices yet')).toBeInTheDocument();
    expect(screen.getByText('No rating history available')).toBeInTheDocument();
    expect(screen.getByText('No emails sent yet')).toBeInTheDocument();
  });

  it('renders player details card and create invoice button', async () => {
    renderGuestDetail();
    await waitFor(() => {
      expect(screen.getByTestId('academy-player-details-card')).toBeInTheDocument();
    });

    const createInvoice = screen.getByTestId('academy-player-create-invoice');
    expect(createInvoice).toHaveAttribute(
      'href',
      `/app/academy/invoices/new?playerId=${encodeURIComponent(`g_${GUEST_ID}`)}`,
    );
  });

  it('renders danger zone at the bottom', async () => {
    renderGuestDetail();
    await waitFor(() => {
      expect(screen.getByTestId('academy-player-remove-card')).toBeInTheDocument();
    });

    expect(getDomIndex('academy-player-remove-card')).toBeGreaterThan(
      getDomIndex('academy-player-section-emails'),
    );
  });

  it('renders guest detail with back link and player name without throwing', async () => {
    expect(() => renderGuestDetail()).not.toThrow();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Jane Guest' })).toBeInTheDocument();
    });

    const backLink = screen.getByRole('link', { name: /Back to players/i });
    expect(backLink).toBeInTheDocument();
    expect(backLink).toHaveAttribute('href', '/app/academy/players');
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
        },
      ];
      resolveCycleRouteMock.mockResolvedValue('/app/academy/cycles/cycle-1');
    });

    it('links cycle rows to the resolved academy cycle page', async () => {
      renderGuestDetail();
      await waitFor(() => {
        expect(screen.getByTestId('academy-player-cycle-link-cycle-1')).toBeInTheDocument();
      });

      expect(screen.getByTestId('academy-player-cycle-link-cycle-1')).toHaveAttribute(
        'href',
        '/app/academy/cycles/cycle-1',
      );
      expect(resolveCycleRouteMock).toHaveBeenCalledWith('cycle-1');
      expect(screen.getByText('Spring Cycle')).toBeInTheDocument();
    });

    it('links invoice rows to the academy invoice edit page', async () => {
      renderGuestDetail();
      await waitFor(() => {
        expect(screen.getByTestId('academy-player-invoice-link-inv-1')).toBeInTheDocument();
      });

      expect(screen.getByTestId('academy-player-invoice-link-inv-1')).toHaveAttribute(
        'href',
        '/app/academy/invoices/inv-1/edit',
      );
      expect(screen.queryByText('No invoices yet')).not.toBeInTheDocument();
    });

    it('uses calendar fallback route for bulk cyclus ids', async () => {
      resolveCycleRouteMock.mockResolvedValue(
        '/app/academy/calendar?tab=list&cyclusId=bulk-cycle-1',
      );
      tableResponses.availability_slots = [
        {
          id: 's1',
          cyclus_id: 'bulk-cycle-1',
          cyclus_name: 'Bulk sessions',
          start_time: '2026-02-01T10:00:00Z',
        },
      ];

      renderGuestDetail();
      await waitFor(() => {
        expect(screen.getByTestId('academy-player-cycle-link-bulk-cycle-1')).toBeInTheDocument();
      });

      expect(screen.getByTestId('academy-player-cycle-link-bulk-cycle-1')).toHaveAttribute(
        'href',
        '/app/academy/calendar?tab=list&cyclusId=bulk-cycle-1',
      );
    });

    it('keeps empty states when there is no related data', async () => {
      for (const key of Object.keys(tableResponses)) {
        delete tableResponses[key];
      }

      renderGuestDetail();
      await waitFor(() => {
        expect(screen.getByText('No cycles joined yet')).toBeInTheDocument();
      });

      expect(screen.queryByTestId(/academy-player-cycle-link-/)).not.toBeInTheDocument();
      expect(screen.queryByTestId(/academy-player-invoice-link-/)).not.toBeInTheDocument();
    });
  });

  it('does not embed cycle or invoice editors on the player detail page', () => {
    const source = readFileSync(resolve(__dirname, 'AcademyPlayerDetail.tsx'), 'utf8');

    expect(source).not.toContain('AcademyEditInvoice');
    expect(source).not.toContain('AcademyCycleDetail');
    expect(source).toContain('buildAcademyInvoiceEditPath');
    expect(source).toContain('resolveAcademyCyclusPricingRoute');
  });
});
