import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SlotList } from './SlotList';

const baseSlot = {
  id: 'slot-1',
  start_time: '2026-04-10T10:00:00Z',
  end_time: '2026-04-10T11:00:00Z',
  court_type: 'indoor' as const,
  price_per_session: 40,
  max_participants: 4,
  allow_single_booking: true,
  averageRating: null,
  ratingSystem: 'knltb',
  spotsLeft: 3,
  location: { id: 'loc-1', name: 'Padel City', city: 'Amsterdam', street_address: 'Main St 1' },
  rating_system: null,
  min_rating: null,
  max_rating: null,
};

const getSlotPrice = (slot: any) => slot.price_per_session || 0;

describe('SlotList', () => {
  it('renders slot date, time, and location', () => {
    render(
      <SlotList
        slots={[baseSlot]}
        selectedSlotId={null}
        hasCycles={false}
        getSlotPrice={getSlotPrice}
        onSelect={() => {}}
      />
    );

    expect(screen.getByText(/Fri, Apr 10/)).toBeInTheDocument();
    expect(screen.getByText(/10:00/)).toBeInTheDocument();
    expect(screen.getByText(/11:00/)).toBeInTheDocument();
    expect(screen.getByText(/Padel City, Amsterdam/)).toBeInTheDocument();
  });

  it('shows "Available Time Slots" heading when no cycles', () => {
    render(
      <SlotList slots={[baseSlot]} selectedSlotId={null} hasCycles={false} getSlotPrice={getSlotPrice} onSelect={() => {}} />
    );
    expect(screen.getByText('Available Time Slots')).toBeInTheDocument();
  });

  it('shows "Individual Sessions" heading when cycles exist', () => {
    render(
      <SlotList slots={[baseSlot]} selectedSlotId={null} hasCycles={true} getSlotPrice={getSlotPrice} onSelect={() => {}} />
    );
    expect(screen.getByText('Individual Sessions')).toBeInTheDocument();
  });

  it('shows empty state when no slots and no cycles', () => {
    render(
      <SlotList slots={[]} selectedSlotId={null} hasCycles={false} getSlotPrice={getSlotPrice} onSelect={() => {}} />
    );
    expect(screen.getByText('No available slots at the moment')).toBeInTheDocument();
  });

  it('shows alternative empty text when no slots but cycles exist', () => {
    render(
      <SlotList slots={[]} selectedSlotId={null} hasCycles={true} getSlotPrice={getSlotPrice} onSelect={() => {}} />
    );
    expect(screen.getByText('No individual sessions available')).toBeInTheDocument();
  });

  it('calls onSelect when a slot is clicked', () => {
    const onSelect = vi.fn();
    render(
      <SlotList slots={[baseSlot]} selectedSlotId={null} hasCycles={false} getSlotPrice={getSlotPrice} onSelect={onSelect} />
    );
    fireEvent.click(screen.getByText(/Fri, Apr 10/));
    expect(onSelect).toHaveBeenCalledWith(baseSlot);
  });

  it('highlights selected slot with check icon', () => {
    const { container } = render(
      <SlotList slots={[baseSlot]} selectedSlotId="slot-1" hasCycles={false} getSlotPrice={getSlotPrice} onSelect={() => {}} />
    );
    // The card should have ring-2 ring-primary classes
    const card = container.querySelector('.ring-2');
    expect(card).toBeTruthy();
  });

  it('displays price per spot for group bookings', () => {
    render(
      <SlotList slots={[baseSlot]} selectedSlotId={null} hasCycles={false} getSlotPrice={getSlotPrice} onSelect={() => {}} />
    );
    // 40 / 4 participants = €10.00/spot
    expect(screen.getByText('€10.00/spot')).toBeInTheDocument();
  });

  it('displays spots left', () => {
    render(
      <SlotList slots={[baseSlot]} selectedSlotId={null} hasCycles={false} getSlotPrice={getSlotPrice} onSelect={() => {}} />
    );
    expect(screen.getByText('3/4 spots left')).toBeInTheDocument();
  });

  it('shows court type indicator', () => {
    render(
      <SlotList slots={[baseSlot]} selectedSlotId={null} hasCycles={false} getSlotPrice={getSlotPrice} onSelect={() => {}} />
    );
    expect(screen.getByText(/Indoor/)).toBeInTheDocument();
  });

  it('shows rating system badge when min/max rating set', () => {
    const ratedSlot = { ...baseSlot, rating_system: 'knltb', min_rating: 3, max_rating: 7 };
    render(
      <SlotList slots={[ratedSlot]} selectedSlotId={null} hasCycles={false} getSlotPrice={getSlotPrice} onSelect={() => {}} />
    );
    expect(screen.getByText(/KNLTB/)).toBeInTheDocument();
    expect(screen.getByText(/3–7/)).toBeInTheDocument();
  });

  it('renders multiple slots', () => {
    const slot2 = { ...baseSlot, id: 'slot-2', start_time: '2026-04-11T14:00:00Z', end_time: '2026-04-11T15:00:00Z' };
    render(
      <SlotList slots={[baseSlot, slot2]} selectedSlotId={null} hasCycles={false} getSlotPrice={getSlotPrice} onSelect={() => {}} />
    );
    expect(screen.getByText(/Fri, Apr 10/)).toBeInTheDocument();
    expect(screen.getByText(/Sat, Apr 11/)).toBeInTheDocument();
  });
});
