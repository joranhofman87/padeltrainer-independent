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

  // ── ABC-16 H0 ────────────────────────────────────────────────────────────────────────────
  // Soft removal wrote — and for a player with no prior overlay row, CREATED — the
  // `academy_player_metadata` row that three authorization predicates accepted as proof of the
  // academy↔player relationship. With no writer, the destructive-looking action is DISABLED
  // rather than left to fail after the user has confirmed it.

  it('still shows the card and the action, but the action is disabled and explained', async () => {
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
    const button = screen.getByTestId('academy-player-remove-button');
    expect(button).toHaveTextContent('Remove from academy');
    expect(button).toBeDisabled();

    // the user is told why, in non-technical language, and that nothing changed
    const note = screen.getByTestId('academy-player-remove-unavailable');
    expect(note).toHaveTextContent(/temporarily unavailable/i);
    expect(note).toHaveTextContent(/nothing about this player has changed/i);
    expect(note.textContent).not.toMatch(/permission denied|row-level security|42501/i);

    // and the destructive vocabulary never appears
    expect(screen.queryByText('Delete account')).not.toBeInTheDocument();
  });

  it('cannot be triggered: no confirm dialog, no writer call, no navigation', async () => {
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

    await waitFor(() => {
      expect(screen.queryByTestId('academy-player-remove-confirm')).toBeNull();
    });
    expect(removeMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
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
