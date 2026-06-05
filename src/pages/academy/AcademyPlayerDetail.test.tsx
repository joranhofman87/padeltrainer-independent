import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import AcademyPlayerDetail from './AcademyPlayerDetail';

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

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: (table: string) => {
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
        'players.detail.tabs.overview': 'Overview',
        'players.detail.tabs.cycles': 'Cycles',
        'players.detail.tabs.invoices': 'Invoices',
        'players.detail.tabs.rating': 'Rating',
        'players.detail.tabs.emails': 'Emails',
        'players.detail.singleSessions': 'Single sessions',
        'players.detail.internalNotes': 'Internal notes',
        'players.detail.internalNotesDesc': 'Private notes',
        'players.notes.placeholder': 'Notes',
        'players.detail.ratingTrend': 'Rating trend',
        'players.detail.noRatingHistory': 'No rating history',
        'players.detail.createInvoice': 'Create invoice',
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

describe('AcademyPlayerDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders player details card on overview', async () => {
    renderGuestDetail();
    await waitFor(() => {
      expect(screen.getByTestId('academy-player-details-card')).toBeInTheDocument();
    });
  });

  it('renders guest detail with back link and player name without throwing', async () => {
    expect(() => renderGuestDetail()).not.toThrow();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Jane Guest' })).toBeInTheDocument();
    });

    const backLink = screen.getByRole('link', { name: /Back to players/i });
    expect(backLink).toBeInTheDocument();
    expect(backLink).toHaveAttribute('href', '/app/academy/players');

    const createInvoice = screen.getByTestId('academy-player-create-invoice');
    expect(createInvoice).toHaveAttribute(
      'href',
      `/app/academy/invoices/new?playerId=${encodeURIComponent(`g_${GUEST_ID}`)}`,
    );
  });
});
