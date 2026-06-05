import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PlayerNotesCell } from './PlayerNotesCell';

vi.mock('@/lib/supabaseClient', () => ({
  supabase: { from: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

describe('PlayerNotesCell', () => {
  it('truncates long notes to a single line in the table trigger', () => {
    const longNote =
      'This is a very long internal note that should not wrap across multiple lines in the players table row';

    render(
      <PlayerNotesCell
        academyId="academy-1"
        playerKey={{ guest_player_id: 'guest-1', profile_id: null }}
        notes={longNote}
        onChanged={vi.fn()}
      />,
    );

    const trigger = screen.getByTestId('player-notes-cell-trigger');
    expect(trigger).toHaveClass('whitespace-nowrap');
    expect(trigger).toHaveAttribute('title', longNote);
    expect(screen.getByText(longNote)).toHaveClass('truncate');
  });

  it('shows add note label when empty', () => {
    render(
      <PlayerNotesCell
        academyId="academy-1"
        playerKey={{ guest_player_id: 'guest-1', profile_id: null }}
        notes=""
        onChanged={vi.fn()}
      />,
    );

    expect(screen.getByText('Add note')).toBeInTheDocument();
  });
});
