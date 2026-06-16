import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const mutate = vi.fn();
let reportData: { reportId: string | null; sessionHappened: boolean | null; trainerSummary: string | null } = {
  reportId: null,
  sessionHappened: null,
  trainerSummary: null,
};

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'auth-1' }, profile: { id: 'profile-1' } }),
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, fb?: string) => fb ?? _k }),
}));
vi.mock('@/lib/sessionReports', () => ({
  useSlotPlayerReport: () => ({ data: reportData }),
  usePlayerReportAttendance: () => ({ mutate, isPending: false }),
}));
vi.mock('@/lib/playerSelfNotes', () => ({
  useSlotOwnNotes: () => ({ data: [] }),
}));
vi.mock('@/components/player/PlayerSelfNoteEditor', () => ({
  PlayerSelfNoteEditor: () => <div data-testid="self-note-editor" />,
}));

import { PlayerSessionReport } from './PlayerSessionReport';

describe('PlayerSessionReport', () => {
  beforeEach(() => {
    mutate.mockReset();
    reportData = { reportId: null, sessionHappened: null, trainerSummary: null };
  });

  it('renders the Yes/No attendance choice and the shared note editor', () => {
    render(<PlayerSessionReport slotId="slot-1" />);
    expect(screen.getByText('Did the training happen?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Yes/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /No/ })).toBeInTheDocument();
    expect(screen.getByTestId('self-note-editor')).toBeInTheDocument();
  });

  it('records "Yes" as session_happened=true', () => {
    render(<PlayerSessionReport slotId="slot-1" />);
    fireEvent.click(screen.getByRole('button', { name: /Yes/ }));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toMatchObject({
      slotId: 'slot-1',
      reporterId: 'profile-1',
      sessionHappened: true,
    });
  });

  it('records "No" as session_happened=false', () => {
    render(<PlayerSessionReport slotId="slot-1" />);
    fireEvent.click(screen.getByRole('button', { name: /No/ }));
    expect(mutate.mock.calls[0][0]).toMatchObject({ sessionHappened: false });
  });

  it('marks the chosen answer as pressed and does not re-save it', () => {
    reportData = { reportId: 'r-1', sessionHappened: true, trainerSummary: null };
    render(<PlayerSessionReport slotId="slot-1" />);
    const yes = screen.getByRole('button', { name: /Yes/ });
    expect(yes).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(yes); // already selected → no-op
    expect(mutate).not.toHaveBeenCalled();
  });
});
