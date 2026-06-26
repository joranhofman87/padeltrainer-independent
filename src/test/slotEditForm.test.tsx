import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithCycles } from './renderWithCycles';
import type { SlotEditFormSlot } from '@/components/slots/SlotEditForm';

// SlotRatingPicker fetches rating systems on mount — stub it so the (large) form renders cheaply.
vi.mock('@/lib/ratingSystems', () => ({ getRatingSystems: () => Promise.resolve([]) }));
const { SlotEditForm } = await import('@/components/slots/SlotEditForm');

const baseSlot: SlotEditFormSlot = {
  start_time: '2026-07-06T18:00:00Z',
  end_time: '2026-07-06T19:00:00Z', // → 60 min (TZ-independent)
  trainer_id: 'tr1',
  location_id: 'loc1',
  max_participants: 4,
  rating_system: 'knltb',
  min_rating: null,
  max_rating: null,
  cyclus_id: null,
  cyclus_name: null,
  is_public: true,
  price_per_session: 25,
  total_price: null,
  split_payment: false,
  prices_include_vat: true,
  extra_costs: [],
};
const trainers = [{ id: 'tr1', name: 'Coach Jansen' }];
const locations = [{ id: 'loc1', name: 'Court A' }];
const noop = () => {};

describe('SlotEditForm (F3b shared)', () => {
  it('initialises fields from the slot (duration/capacity/price) — non-cycle slot', () => {
    renderWithCycles(
      <SlotEditForm slot={baseSlot} namespace="academy" trainers={trainers} locations={locations} onSubmit={noop} onCancel={noop} />,
    );
    expect(screen.getByText('60 min')).toBeInTheDocument(); // duration select value
    expect(screen.getByDisplayValue('4')).toBeInTheDocument(); // max participants
    const price = screen.getByDisplayValue('25'); // price per session
    expect(price).toBeInTheDocument();
    expect(price).not.toBeDisabled(); // editable for a non-cycle slot
  });

  it('shows the trainer select ONLY when a trainer list is passed (academy yes / trainer no)', () => {
    const { unmount } = renderWithCycles(
      <SlotEditForm slot={baseSlot} namespace="academy" trainers={trainers} locations={locations} onSubmit={noop} onCancel={noop} />,
    );
    expect(screen.getByText('Coach Jansen')).toBeInTheDocument(); // academy: trainer select renders the name
    unmount();
    renderWithCycles(
      <SlotEditForm slot={baseSlot} namespace="trainer" locations={locations} onSubmit={noop} onCancel={noop} />,
    );
    expect(screen.queryByText('Coach Jansen')).not.toBeInTheDocument(); // trainer: no trainer select
  });

  it('cycle slot: price disabled, cyclus name + apply-to-cyclus shown, callout link only with onEditCyclePricing', () => {
    const onEditCyclePricing = vi.fn();
    renderWithCycles(
      <SlotEditForm
        slot={{ ...baseSlot, cyclus_id: 'cy1', cyclus_name: 'Zomer 2026' }}
        namespace="academy"
        trainers={trainers}
        locations={locations}
        onEditCyclePricing={onEditCyclePricing}
        onSubmit={noop}
        onCancel={noop}
      />,
    );
    expect(screen.getByDisplayValue('25')).toBeDisabled(); // price locked for cycle slots
    expect(screen.getByText(/managed at the cycle level/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue('Zomer 2026')).toBeInTheDocument(); // cyclus name
    expect(screen.getByRole('checkbox')).toBeInTheDocument(); // apply-to-cyclus
    fireEvent.click(screen.getByRole('button', { name: /edit cycle pricing/i }));
    expect(onEditCyclePricing).toHaveBeenCalled();
  });

  it('non-cycle slot has no apply-to-cyclus checkbox and no cycle-pricing callout', () => {
    renderWithCycles(
      <SlotEditForm slot={baseSlot} namespace="trainer" locations={locations} onSubmit={noop} onCancel={noop} />,
    );
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText(/managed at the cycle level/i)).not.toBeInTheDocument();
  });

  it('Save emits the field values + applyToCyclus; Cancel calls onCancel', () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    renderWithCycles(
      <SlotEditForm slot={baseSlot} namespace="trainer" locations={locations} onSubmit={onSubmit} onCancel={onCancel} />,
    );
    fireEvent.change(screen.getByDisplayValue('4'), { target: { value: '6' } }); // edit capacity
    fireEvent.click(screen.getByRole('button', { name: /save|opslaan/i }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const [values, applyToCyclus] = onSubmit.mock.calls[0];
    expect(values).toMatchObject({
      duration: 60,
      maxParticipants: 6, // the edit was captured
      trainerId: 'tr1',
      locationId: 'loc1',
      pricePerSession: '25',
      splitPayment: false,
      pricesIncludeVat: true,
      isMarkedFull: false,
      extraCosts: [],
    });
    expect(applyToCyclus).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /cancel|annuleren/i }));
    expect(onCancel).toHaveBeenCalled();
  });
});
