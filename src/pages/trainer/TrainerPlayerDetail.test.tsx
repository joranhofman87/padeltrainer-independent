import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import TrainerPlayerDetail from './TrainerPlayerDetail';

const TRAINER_ID = 'trainer-uuid-1';
const OTHER_TRAINER_GUEST = 'guest-other-trainer';
const OWN_GUEST = 'guest-own';

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1' } }),
}));

vi.mock('@/lib/invoiceSelectablePlayers', () => ({
  isTrainerRegisteredPlayerVisible: vi.fn(),
}));

import { isTrainerRegisteredPlayerVisible } from '@/lib/invoiceSelectablePlayers';

function mockFrom(table: string) {
  if (table === 'trainer_profiles') {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: { id: TRAINER_ID }, error: null }),
        }),
      }),
    };
  }
  if (table === 'guest_players') {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({
              data: {
                id: OWN_GUEST,
                full_name: 'Own Guest',
                email: 'g@test.com',
                phone: null,
                trainer_id: TRAINER_ID,
                linked_profile_id: null,
              },
              error: null,
            }),
        }),
      }),
    };
  }
  if (table === 'invoices') {
    return {
      select: () => ({
        eq: () => ({
          eq: () => ({
            order: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    };
  }
  return {
    select: () => ({
      eq: () => ({
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
      }),
    }),
  };
}

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: (table: string) => mockFrom(table),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/app/trainer/players/:playerId" element={<TrainerPlayerDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('TrainerPlayerDetail access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isTrainerRegisteredPlayerVisible).mockResolvedValue(false);
  });

  it('shows own guest player', async () => {
    renderAt(`/app/trainer/players/g_${OWN_GUEST}`);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Own Guest' })).toBeInTheDocument();
    });
    expect(screen.getByTestId('trainer-player-create-invoice')).toBeInTheDocument();
  });

  it('shows not found for registered player not on trainer roster', async () => {
    renderAt('/app/trainer/players/p_foreign-profile');
    await waitFor(() => {
      expect(screen.getByText('Player not found')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('trainer-player-create-invoice')).not.toBeInTheDocument();
  });

});
