import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { AcademyPlayerDetailsCard } from './AcademyPlayerDetailsCard';

const LOC_A = '11111111-1111-4111-8111-111111111111';

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

const locations = [{ id: LOC_A, name: 'Club A' }];

const baseValues = {
  name: 'Jane Guest',
  email: 'jane@example.com',
  phone: null,
  locationId: LOC_A,
  skillRating: 4.5,
  ratingSystem: 'knltb',
  notes: 'Some notes',
};

describe('AcademyPlayerDetailsCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveMock.mockResolvedValue({});
  });

  it('shows preferred club from location id', () => {
    render(
      <AcademyPlayerDetailsCard
        kind="guest"
        academyProfileId="academy-1"
        guestPlayerId="guest-1"
        profileId={null}
        values={baseValues}
        locations={locations}
        onSaved={vi.fn()}
      />,
    );

    expect(screen.getByText('Preferred club')).toBeInTheDocument();
    expect(screen.getByText('Club A')).toBeInTheDocument();
  });

  it('shows registered email as read-only in edit mode with helper text', () => {
    render(
      <AcademyPlayerDetailsCard
        kind="registered"
        academyProfileId="academy-1"
        guestPlayerId={null}
        profileId="profile-1"
        values={{ ...baseValues, email: 'registered@example.com' }}
        locations={locations}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('academy-player-details-edit'));

    const emailInput = screen.getByTestId('academy-player-details-email') as HTMLInputElement;
    expect(emailInput).toHaveAttribute('readonly');
    expect(emailInput).toBeDisabled();
    expect(
      screen.getByText(/This player has claimed their account/i),
    ).toBeInTheDocument();
  });

  it('saves guest player email and preferred location id', async () => {
    render(
      <AcademyPlayerDetailsCard
        kind="guest"
        academyProfileId="academy-1"
        guestPlayerId="guest-1"
        profileId={null}
        values={baseValues}
        locations={locations}
        onSaved={vi.fn()}
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
          form: expect.objectContaining({
            email: 'newguest@example.com',
            locationId: LOC_A,
          }),
          allowedLocationIds: expect.any(Set),
        }),
      );
    });
  });

  it('keeps registered club and notes read-only, strips overlay writes, and preserves prior values on save', async () => {
    const onSaved = vi.fn();

    render(
      <AcademyPlayerDetailsCard
        kind="registered"
        academyProfileId="academy-1"
        guestPlayerId={null}
        profileId="profile-1"
        values={{ ...baseValues, email: 'registered@example.com' }}
        locations={locations}
        onSaved={onSaved}
      />,
    );

    fireEvent.click(screen.getByTestId('academy-player-details-edit'));
    expect(screen.getByTestId('academy-player-details-club-readonly')).toHaveTextContent('Club A');
    expect(screen.getByTestId('academy-player-details-notes-readonly')).toHaveTextContent('Some notes');
    fireEvent.change(screen.getByTestId('academy-player-details-name'), {
      target: { value: 'Updated Registered' },
    });
    fireEvent.click(screen.getByTestId('academy-player-details-save'));

    await waitFor(() => {
      expect(saveMock).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'registered',
          form: expect.objectContaining({
            name: 'Updated Registered',
            locationId: '',
            notes: '',
          }),
        }),
      );
    });

    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({
        locationId: LOC_A,
        notes: 'Some notes',
        email: 'registered@example.com',
      }),
    );
  });

  it('cancel restores original values', () => {
    render(
      <AcademyPlayerDetailsCard
        kind="guest"
        academyProfileId="academy-1"
        guestPlayerId="guest-1"
        profileId={null}
        values={baseValues}
        locations={locations}
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
