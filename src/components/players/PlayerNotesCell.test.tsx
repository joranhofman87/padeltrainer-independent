import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PlayerNotesCell } from './PlayerNotesCell';

// The cell must not reach the database at all now — the mock exists to prove that, so it
// deliberately has no usable chain.
const fromMock = vi.fn();
vi.mock('@/lib/supabaseClient', () => ({ supabase: { from: (t: string) => fromMock(t) } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

/**
 * ABC-16 H0 — the note editor is gone; the note itself is not.
 *
 * The popover wrote `academy_player_metadata` directly, creating the row when none existed —
 * the row three authorization predicates accepted as proof of the academy↔player
 * relationship. Under H0 there is no writer, so the control is rendered read-only rather than
 * left to fail on save. What must NOT happen is the note disappearing: hiding existing data
 * would be a second, self-inflicted problem.
 */
describe('PlayerNotesCell', () => {
  it('still shows the note, truncated to a single line', () => {
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

    expect(screen.getByText(longNote)).toHaveClass('truncate');
    expect(screen.getByTestId('player-notes-cell-readonly')).toHaveAttribute(
      'title',
      expect.stringContaining(longNote) as unknown as string,
    );
  });

  it('offers no editor: there is no trigger to open and no request is made', () => {
    render(
      <PlayerNotesCell
        academyId="academy-1"
        playerKey={{ guest_player_id: 'guest-1', profile_id: null }}
        notes="a note"
        onChanged={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('player-notes-cell-trigger')).toBeNull();
    expect(screen.queryByText('Add note')).toBeNull();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('explains WHY it is read-only rather than just going inert', () => {
    render(
      <PlayerNotesCell
        academyId="academy-1"
        playerKey={{ guest_player_id: 'guest-1', profile_id: null }}
        notes=""
        onChanged={vi.fn()}
      />,
    );

    const cell = screen.getByTestId('player-notes-cell-readonly');
    expect(cell.getAttribute('title')).toMatch(/view-only/i);
    // and an empty note still renders a placeholder, not a blank cell
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
