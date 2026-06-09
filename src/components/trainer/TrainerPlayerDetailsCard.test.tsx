import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TrainerPlayerDetailsCard } from './TrainerPlayerDetailsCard';

const LOC_A = '11111111-1111-4111-8111-111111111111';

const saveMock = vi.fn();

vi.mock('@/lib/trainerPlayerDetails', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/trainerPlayerDetails')>();
  return {
    ...actual,
    saveTrainerPlayerDetails: (...args: unknown[]) => saveMock(...args),
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

describe('TrainerPlayerDetailsCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveMock.mockResolvedValue({});
  });

  it('shows registered email as read-only in edit mode', () => {
    render(
      <TrainerPlayerDetailsCard
        kind="registered"
        trainerProfileId="trainer-1"
        guestPlayerId={null}
        profileId="profile-1"
        values={{ ...baseValues, email: 'registered@example.com' }}
        locations={locations}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('trainer-player-details-edit'));

    const emailInput = screen.getByTestId('trainer-player-details-email') as HTMLInputElement;
    expect(emailInput).toHaveAttribute('readonly');
    expect(emailInput).toBeDisabled();
    expect(screen.getByTestId('trainer-player-email-readonly-help')).toBeInTheDocument();
  });

  it('allows guest email editing', () => {
    render(
      <TrainerPlayerDetailsCard
        kind="guest"
        trainerProfileId="trainer-1"
        guestPlayerId="guest-1"
        profileId={null}
        values={baseValues}
        locations={locations}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('trainer-player-details-edit'));

    const emailInput = screen.getByTestId('trainer-player-details-email') as HTMLInputElement;
    expect(emailInput).not.toHaveAttribute('readonly');
    expect(emailInput).not.toBeDisabled();
  });
});
