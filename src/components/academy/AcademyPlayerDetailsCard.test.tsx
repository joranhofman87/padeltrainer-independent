import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { AcademyPlayerDetailsCard } from './AcademyPlayerDetailsCard';

const saveMock = vi.fn();

vi.mock('@/lib/academyPlayerDetails', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/academyPlayerDetails')>();
  return {
    ...actual,
    saveAcademyPlayerDetails: (...args: unknown[]) => saveMock(...args),
  };
});

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

const baseValues = {
  name: 'Jane Guest',
  email: 'jane@example.com',
  locationId: 'loc-1',
  locationName: 'Club A',
  skillRating: 4.5,
  ratingSystem: 'knltb',
  notes: 'Some notes',
};

describe('AcademyPlayerDetailsCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveMock.mockResolvedValue({});
  });

  it('shows editable fields in read mode', () => {
    render(
      <AcademyPlayerDetailsCard
        kind="guest"
        academyProfileId="academy-1"
        guestPlayerId="guest-1"
        profileId={null}
        values={baseValues}
        locations={[{ id: 'loc-1', name: 'Club A' }]}
        onSaved={vi.fn()}
      />,
    );

    expect(screen.getByTestId('academy-player-details-card')).toBeInTheDocument();
    expect(screen.getByText('Jane Guest')).toBeInTheDocument();
    expect(screen.getByText('jane@example.com')).toBeInTheDocument();
    expect(screen.getByText('Club A')).toBeInTheDocument();
    expect(screen.getByText('4.5')).toBeInTheDocument();
    expect(screen.getByText('Some notes')).toBeInTheDocument();
  });

  it('shows registered email normally in read mode without helper text', () => {
    render(
      <AcademyPlayerDetailsCard
        kind="registered"
        academyProfileId="academy-1"
        guestPlayerId={null}
        profileId="profile-1"
        values={{ ...baseValues, email: 'registered@example.com' }}
        locations={[{ id: 'loc-1', name: 'Club A' }]}
        onSaved={vi.fn()}
      />,
    );

    expect(screen.getByText('registered@example.com')).toBeInTheDocument();
    expect(
      screen.queryByText(/This player has claimed their account/i),
    ).not.toBeInTheDocument();
  });

  it('shows registered email as read-only in edit mode with helper text', () => {
    render(
      <AcademyPlayerDetailsCard
        kind="registered"
        academyProfileId="academy-1"
        guestPlayerId={null}
        profileId="profile-1"
        values={{ ...baseValues, email: 'registered@example.com' }}
        locations={[{ id: 'loc-1', name: 'Club A' }]}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('academy-player-details-edit'));

    const emailInput = screen.getByTestId('academy-player-details-email') as HTMLInputElement;
    expect(emailInput).toHaveAttribute('readonly');
    expect(emailInput).toBeDisabled();
    expect(emailInput.value).toBe('registered@example.com');
    expect(screen.getByTestId('academy-player-email-readonly-help')).toHaveTextContent(
      /This player has claimed their account/i,
    );
  });

  it('allows guest email edits in edit mode', () => {
    render(
      <AcademyPlayerDetailsCard
        kind="guest"
        academyProfileId="academy-1"
        guestPlayerId="guest-1"
        profileId={null}
        values={baseValues}
        locations={[{ id: 'loc-1', name: 'Club A' }]}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('academy-player-details-edit'));

    const emailInput = screen.getByTestId('academy-player-details-email') as HTMLInputElement;
    expect(emailInput).not.toHaveAttribute('readonly');
    expect(emailInput).not.toBeDisabled();
    fireEvent.change(emailInput, { target: { value: 'updated@example.com' } });
    expect(emailInput.value).toBe('updated@example.com');
  });

  it('saves guest player email changes', async () => {
    const onSaved = vi.fn();

    render(
      <AcademyPlayerDetailsCard
        kind="guest"
        academyProfileId="academy-1"
        guestPlayerId="guest-1"
        profileId={null}
        values={baseValues}
        locations={[{ id: 'loc-1', name: 'Club A' }]}
        onSaved={onSaved}
      />,
    );

    fireEvent.click(screen.getByTestId('academy-player-details-edit'));
    fireEvent.change(screen.getByTestId('academy-player-details-email'), {
      target: { value: 'newguest@example.com' },
    });
    fireEvent.click(screen.getByTestId('academy-player-details-save'));

    await waitFor(() => {
      expect(saveMock).toHaveBeenCalledWith(
        expect.objectContaining({
          form: expect.objectContaining({ email: 'newguest@example.com' }),
        }),
      );
    });
  });

  it('saves registered player non-email fields without sending email', async () => {
    const onSaved = vi.fn();

    render(
      <AcademyPlayerDetailsCard
        kind="registered"
        academyProfileId="academy-1"
        guestPlayerId={null}
        profileId="profile-1"
        values={{ ...baseValues, email: 'registered@example.com' }}
        locations={[{ id: 'loc-1', name: 'Club A' }, { id: 'loc-2', name: 'Club B' }]}
        onSaved={onSaved}
      />,
    );

    fireEvent.click(screen.getByTestId('academy-player-details-edit'));
    fireEvent.change(screen.getByTestId('academy-player-details-name'), {
      target: { value: 'Updated Registered' },
    });
    fireEvent.change(screen.getByTestId('academy-player-details-rating'), {
      target: { value: '7' },
    });
    fireEvent.change(screen.getByTestId('academy-player-details-notes'), {
      target: { value: 'Updated notes' },
    });
    fireEvent.click(screen.getByTestId('academy-player-details-save'));

    await waitFor(() => {
      expect(saveMock).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'registered',
          form: expect.objectContaining({
            name: 'Updated Registered',
            skillRating: '7',
            notes: 'Updated notes',
            email: 'registered@example.com',
          }),
        }),
      );
    });

    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Updated Registered',
        email: 'registered@example.com',
        skillRating: 7,
        notes: 'Updated notes',
      }),
    );
  });

  it('saves guest player details and calls onSaved', async () => {
    const onSaved = vi.fn();

    render(
      <AcademyPlayerDetailsCard
        kind="guest"
        academyProfileId="academy-1"
        guestPlayerId="guest-1"
        profileId={null}
        values={baseValues}
        locations={[{ id: 'loc-1', name: 'Club A' }]}
        onSaved={onSaved}
      />,
    );

    fireEvent.click(screen.getByTestId('academy-player-details-edit'));
    fireEvent.change(screen.getByTestId('academy-player-details-name'), {
      target: { value: 'Updated Name' },
    });
    fireEvent.click(screen.getByTestId('academy-player-details-save'));

    await waitFor(() => {
      expect(saveMock).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'guest',
          academyProfileId: 'academy-1',
          guestPlayerId: 'guest-1',
          form: expect.objectContaining({ name: 'Updated Name' }),
        }),
      );
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it('cancel restores original values', () => {
    render(
      <AcademyPlayerDetailsCard
        kind="guest"
        academyProfileId="academy-1"
        guestPlayerId="guest-1"
        profileId={null}
        values={baseValues}
        locations={[{ id: 'loc-1', name: 'Club A' }]}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('academy-player-details-edit'));
    fireEvent.change(screen.getByTestId('academy-player-details-name'), {
      target: { value: 'Temporary' },
    });
    fireEvent.click(screen.getByText('Cancel'));

    expect(screen.getByText('Jane Guest')).toBeInTheDocument();
    expect(saveMock).not.toHaveBeenCalled();
  });
});
