import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { TrainerPlayerRemoveCard } from './TrainerPlayerRemoveCard';

const renderWithClient = (ui: ReactElement) =>
  render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

const removeMock = vi.fn();
const navigateMock = vi.fn();

vi.mock('@/lib/trainerPlayerRemoval', () => ({
  removePlayerFromTrainer: (...args: unknown[]) => removeMock(...args),
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
          maybeSingle: () => Promise.resolve({ data: { id: 'trainer-profile' } }),
        }),
      }),
    }),
  },
}));

describe('TrainerPlayerRemoveCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    removeMock.mockResolvedValue({ removed_at: '2026-05-30T12:00:00Z' });
  });

  // ── ABC-16 H0 — see AcademyPlayerRemoveCard.test.tsx; the trainer arm closes with the
  // academy arm because its policy proves only that the caller owns the ROW.

  it('still shows the card and the action, but the action is disabled and explained', async () => {
    renderWithClient(
      <TrainerPlayerRemoveCard
        kind="registered"
        trainerProfileId="trainer-1"
        guestPlayerId={null}
        profileId="profile-1"
        playerName="Jane Player"
        removedAt={null}
      />,
    );

    expect(screen.getByTestId('trainer-player-remove-card')).toBeInTheDocument();
    const button = screen.getByTestId('trainer-player-remove-button');
    expect(button).toHaveTextContent('Remove from trainer');
    expect(button).toBeDisabled();

    const note = screen.getByTestId('trainer-player-remove-unavailable');
    expect(note).toHaveTextContent(/temporarily unavailable/i);
    expect(note.textContent).not.toMatch(/permission denied|row-level security|42501/i);

    expect(screen.queryByText('Delete account')).not.toBeInTheDocument();
  });

  it('cannot be triggered: no confirm dialog, no writer call, no navigation', async () => {
    renderWithClient(
      <TrainerPlayerRemoveCard
        kind="guest"
        trainerProfileId="trainer-1"
        guestPlayerId="guest-1"
        profileId={null}
        playerName="Guest Player"
        removedAt={null}
      />,
    );

    fireEvent.click(screen.getByTestId('trainer-player-remove-button'));

    await waitFor(() => {
      expect(screen.queryByTestId('trainer-player-remove-confirm')).toBeNull();
    });
    expect(removeMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('shows removed banner when player already removed', () => {
    renderWithClient(
      <TrainerPlayerRemoveCard
        kind="registered"
        trainerProfileId="trainer-1"
        guestPlayerId={null}
        profileId="profile-1"
        playerName="Jane Player"
        removedAt="2026-05-30T12:00:00Z"
      />,
    );

    expect(screen.getByTestId('trainer-player-removed-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('trainer-player-remove-button')).not.toBeInTheDocument();
  });
});
