import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { AcademyPlayerRemoveCard } from './AcademyPlayerRemoveCard';

const renderWithClient = (ui: ReactElement) =>
  render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

const removeMock = vi.fn();
const navigateMock = vi.fn();

vi.mock('@/lib/academyPlayerRemoval', () => ({
  removePlayerFromAcademy: (...args: unknown[]) => removeMock(...args),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'auth-user' } } }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: { id: 'manager-profile' } }),
        }),
      }),
    }),
  },
}));

describe('AcademyPlayerRemoveCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    removeMock.mockResolvedValue({ removed_at: '2026-05-30T12:00:00Z' });
  });

  it('shows remove from academy action with safe confirmation copy', async () => {
    renderWithClient(
      <AcademyPlayerRemoveCard
        kind="registered"
        academyProfileId="academy-1"
        guestPlayerId={null}
        profileId="profile-1"
        playerName="Jane Player"
        removedAt={null}
      />,
    );

    expect(screen.getByTestId('academy-player-remove-card')).toBeInTheDocument();
    expect(screen.getByTestId('academy-player-remove-button')).toHaveTextContent('Remove from academy');
    expect(screen.queryByText('Delete account')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('academy-player-remove-button'));
    expect(screen.getByText('Remove player from academy?')).toBeInTheDocument();
    expect(
      screen.getByText(/will not delete their account or historical bookings\/invoices/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/delete account/i)).not.toBeInTheDocument();
  });

  it('calls academy-scoped removal and navigates back', async () => {
    renderWithClient(
      <AcademyPlayerRemoveCard
        kind="guest"
        academyProfileId="academy-1"
        guestPlayerId="guest-1"
        profileId={null}
        playerName="Guest Player"
        removedAt={null}
      />,
    );

    fireEvent.click(screen.getByTestId('academy-player-remove-button'));
    fireEvent.click(screen.getByTestId('academy-player-remove-confirm'));

    await waitFor(() => {
      expect(removeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          academyProfileId: 'academy-1',
          guestPlayerId: 'guest-1',
          profileId: null,
        }),
      );
      expect(navigateMock).toHaveBeenCalledWith('/app/academy/players');
    });
  });

  it('shows removed banner when player already removed', () => {
    renderWithClient(
      <AcademyPlayerRemoveCard
        kind="registered"
        academyProfileId="academy-1"
        guestPlayerId={null}
        profileId="profile-1"
        playerName="Jane Player"
        removedAt="2026-05-30T12:00:00Z"
      />,
    );

    expect(screen.getByTestId('academy-player-removed-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('academy-player-remove-button')).not.toBeInTheDocument();
  });
});
