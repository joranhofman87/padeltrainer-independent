// TrainerAttendanceForm roster sync (review finding on the trainer-audit batch):
// the form used to seed its "everyone attended" default ONCE — a player added to
// the slot afterwards (slot detail's add-player sits right above the form)
// rendered unchecked and was silently saved as ABSENT; removed players lingered
// as ghost ids. The form now prunes removed ids, auto-checks freshly added
// players, and never overrides a manual uncheck.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { TrainerAttendanceForm } from '@/components/attendance/TrainerAttendanceForm';

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null }) }),
        }),
      }),
    }),
  },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ profile: { id: 'trainer-profile-1' } }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const roster = (names: string[]) =>
  names.map(n => ({ id: `booking-${n}`, name: n, playerId: `player-${n}` }));

const checkbox = (name: string) => screen.getByRole('checkbox', { name });

describe('TrainerAttendanceForm roster sync', () => {
  it('a player added while the form is mounted defaults to ATTENDED, not absent', async () => {
    const { rerender } = render(<TrainerAttendanceForm slotId="slot-1" players={roster(['Anna'])} />);
    await waitFor(() => expect(checkbox('Anna')).toBeInTheDocument());
    expect(checkbox('Anna')).toHaveAttribute('aria-checked', 'true');

    rerender(<TrainerAttendanceForm slotId="slot-1" players={roster(['Anna', 'Ben'])} />);
    await waitFor(() => expect(checkbox('Ben')).toBeInTheDocument());
    expect(checkbox('Ben')).toHaveAttribute('aria-checked', 'true');
  });

  it('a manual uncheck survives roster changes; the new player still gets checked', async () => {
    const { rerender } = render(<TrainerAttendanceForm slotId="slot-2" players={roster(['Anna', 'Ben'])} />);
    await waitFor(() => expect(checkbox('Anna')).toBeInTheDocument());

    fireEvent.click(checkbox('Anna'));
    expect(checkbox('Anna')).toHaveAttribute('aria-checked', 'false');

    rerender(<TrainerAttendanceForm slotId="slot-2" players={roster(['Anna', 'Ben', 'Cas'])} />);
    await waitFor(() => expect(checkbox('Cas')).toBeInTheDocument());
    expect(checkbox('Cas')).toHaveAttribute('aria-checked', 'true');
    expect(checkbox('Anna')).toHaveAttribute('aria-checked', 'false');
    expect(checkbox('Ben')).toHaveAttribute('aria-checked', 'true');
  });

  it('a removed player disappears instead of lingering as a ghost attendee', async () => {
    const { rerender } = render(<TrainerAttendanceForm slotId="slot-3" players={roster(['Anna', 'Ben'])} />);
    await waitFor(() => expect(checkbox('Ben')).toBeInTheDocument());

    rerender(<TrainerAttendanceForm slotId="slot-3" players={roster(['Anna'])} />);
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Ben' })).not.toBeInTheDocument());
    expect(checkbox('Anna')).toHaveAttribute('aria-checked', 'true');
  });
});
