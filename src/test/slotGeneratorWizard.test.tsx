import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithCycles } from './renderWithCycles';

const navigateSpy = vi.fn();
vi.mock('react-router-dom', async (orig) => {
  const actual = await orig<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateSpy };
});

const { MemoryRouter } = await import('react-router-dom');

const { SlotGeneratorWizard } = await import('@/components/cycles/SlotGeneratorWizard');

const locations = [{ id: 'loc1', name: 'Court A', city: 'Amsterdam' }];

beforeEach(() => navigateSpy.mockReset());

describe('SlotGeneratorWizard', () => {
  it('trainer side (self): renders NO trainer dropdown', () => {
    renderWithCycles(
      <SlotGeneratorWizard
        ownerType="trainer"
        ownerId="tr1"
        backHref="/app/trainer/cycles"
        trainerSelection={{ mode: 'self', trainerId: 'tr1' }}
        availableLocations={locations}
      />,
    );
    expect(screen.queryByLabelText('Trainer')).toBeNull();
  });

  it('academy side (pick): renders a trainer dropdown from the injected list', () => {
    renderWithCycles(
      <SlotGeneratorWizard
        ownerType="academy"
        ownerId="ac1"
        backHref="/app/academy/registrations"
        trainerSelection={{ mode: 'pick', trainers: [{ id: 'tr1', name: 'Coach Jansen' }] }}
        availableLocations={locations}
      />,
    );
    expect(screen.getByLabelText('Trainer')).toBeInTheDocument();
  });

  it('academy with NO locations: shows the add-location helper + link in the field (no picker)', () => {
    renderWithCycles(
      <MemoryRouter>
        <SlotGeneratorWizard
          ownerType="academy"
          ownerId="ac1"
          backHref="/app/academy/registrations"
          trainerSelection={{ mode: 'self', trainerId: 'tr1' }}
          availableLocations={[]}
          manageLocationsHref="/app/academy/locations"
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('Locatie')).toBeInTheDocument();
    expect(screen.getByText(/Voeg eerst een locatie toe/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Naar locaties' })).toHaveAttribute('href', '/app/academy/locations');
  });

  it('academy: location is required — cannot advance to preview without one', () => {
    renderWithCycles(
      <MemoryRouter>
        <SlotGeneratorWizard
          ownerType="academy"
          ownerId="ac1"
          backHref="/app/academy/registrations"
          trainerSelection={{ mode: 'self', trainerId: 'tr1' }}
          availableLocations={[]}
          manageLocationsHref="/app/academy/locations"
        />
      </MemoryRouter>,
    );
    // Fill everything EXCEPT location, so the location requirement is the only thing blocking.
    fireEvent.change(screen.getByLabelText('Naam'), { target: { value: 'Herfst training' } });
    fireEvent.change(screen.getByLabelText('Prijs per sessie (€)'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('Startdatum'), { target: { value: '2026-06-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Einddatum' }));
    fireEvent.click(screen.getByRole('gridcell', { name: '28' }));
    fireEvent.click(screen.getByRole('button', { name: 'Monday' }));
    fireEvent.click(screen.getByRole('button', { name: 'Voorbeeld' }));
    // Blocked by the location requirement — never reaches the preview step.
    expect(screen.queryByRole('button', { name: 'Sessies aanmaken' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Voorbeeld' })).toBeInTheDocument();
  });

  it('configure → preview → generate → done step (live immediately, no publish step)', async () => {
    const generate = vi.fn().mockResolvedValue({ cycleIds: ['c1'], cyclesCreated: 1, slotsCreated: 25, skippedOverlaps: 0 });
    renderWithCycles(
      <SlotGeneratorWizard
        ownerType="trainer"
        ownerId="tr1"
        backHref="/app/trainer/cycles"
        trainerSelection={{ mode: 'self', trainerId: 'tr1' }}
        availableLocations={locations}
        generate={generate}
      />,
    );

    fireEvent.change(screen.getByLabelText('Naam'), { target: { value: 'Summer training' } });
    fireEvent.change(screen.getByLabelText('Prijs per sessie (€)'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('Startdatum'), { target: { value: '2026-06-01' } });
    // End date via the shared calendar popover: pick day 28 of the shown (current) month —
    // always after the fixed 2026-06-01 start in this suite's unfrozen clock.
    fireEvent.click(screen.getByRole('button', { name: 'Einddatum' }));
    fireEvent.click(screen.getByRole('gridcell', { name: '28' }));
    fireEvent.click(screen.getByRole('button', { name: 'Monday' }));

    fireEvent.click(screen.getByRole('button', { name: 'Voorbeeld' }));
    // preview step renders the planned-session list
    expect(await screen.findByRole('button', { name: 'Sessies aanmaken' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sessies aanmaken' }));

    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    const input = generate.mock.calls[0][0];
    expect(input).toMatchObject({
      ownerType: 'trainer',
      ownerId: 'tr1',
      trainerId: 'tr1',
      cycleName: 'Summer training',
      pricePerSession: 20,
      allowSingleBooking: false, // default booking mode = whole cycle only
      wholeSlotBooking: false,
      allowCyclusBooking: true,
      publishVisibility: 'private', // default
    });
    // Start/end dates drive the plan now — no week count anywhere.
    expect(input.plan.weeks).toBeUndefined();
    expect(input.plan.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(input.plan.endDate.endsWith('-28')).toBe(true);
    expect(input.plan.weekdays).toEqual(['monday']);
    expect(input.plan.windowStart).toBe('15:00');
    expect(input.plan.timezone).toBe('Europe/Amsterdam');

    // After generate we land on the 'done' step — cycles are already live; no publish
    // step exists anymore. The single button returns to the overview.
    expect(await screen.findByText(/cycli aangemaakt/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Publiceer/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Naar overzicht' }));
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith('/app/trainer/cycles'));
  });

  it('honors the role-isolation guardrail (no cross-role imports)', () => {
    const src = readFileSync('src/components/cycles/SlotGeneratorWizard.tsx', 'utf8');
    expect(src).not.toMatch(/@\/components\/(trainer|academy|club|player)\//);
    expect(src).not.toMatch(/@\/pages\/(trainer|academy|club)\//);
  });
});
