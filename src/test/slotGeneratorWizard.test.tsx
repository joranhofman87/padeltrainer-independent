import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithCycles } from './renderWithCycles';

const navigateSpy = vi.fn();
vi.mock('react-router-dom', async (orig) => {
  const actual = await orig<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateSpy };
});

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

  it('configure → preview → generate → done step → publish all', async () => {
    const generate = vi.fn().mockResolvedValue({ cycleIds: ['c1'], cyclesCreated: 1, slotsCreated: 25, skippedOverlaps: 0 });
    const publishAll = vi.fn().mockResolvedValue({ published: 1, failed: 0 });
    renderWithCycles(
      <SlotGeneratorWizard
        ownerType="trainer"
        ownerId="tr1"
        backHref="/app/trainer/cycles"
        trainerSelection={{ mode: 'self', trainerId: 'tr1' }}
        availableLocations={locations}
        generate={generate}
        publishAll={publishAll}
      />,
    );

    fireEvent.change(screen.getByLabelText('Naam'), { target: { value: 'Summer training' } });
    fireEvent.change(screen.getByLabelText('Prijs per sessie (€)'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('Startdatum'), { target: { value: '2026-06-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Monday' }));

    fireEvent.click(screen.getByRole('button', { name: 'Voorbeeld' }));
    // preview step renders the planned-session list
    expect(await screen.findByRole('button', { name: 'Genereer als concept' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Genereer als concept' }));

    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    const input = generate.mock.calls[0][0];
    expect(input).toMatchObject({
      ownerType: 'trainer',
      ownerId: 'tr1',
      trainerId: 'tr1',
      cycleName: 'Summer training',
      pricePerSession: 20,
      allowSingleBooking: false, // default booking mode = whole cycle
      publishVisibility: 'private', // default
    });
    expect(input.plan.weekdays).toEqual(['monday']);
    expect(input.plan.windowStart).toBe('15:00');
    expect(input.plan.timezone).toBe('Europe/Amsterdam');

    // After generate we land on the 'done' step (no auto-navigate); publish-all then ships + returns.
    const publishBtn = await screen.findByRole('button', { name: /Publiceer alle/ });
    fireEvent.click(publishBtn);
    // default visibility = private → makePublic = false
    await waitFor(() => expect(publishAll).toHaveBeenCalledWith(['c1'], false));
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith('/app/trainer/cycles'));
  });

  it('honors the role-isolation guardrail (no cross-role imports)', () => {
    const src = readFileSync('src/components/cycles/SlotGeneratorWizard.tsx', 'utf8');
    expect(src).not.toMatch(/@\/components\/(trainer|academy|club|player)\//);
    expect(src).not.toMatch(/@\/pages\/(trainer|academy|club)\//);
  });
});
