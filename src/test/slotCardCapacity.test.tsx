// Day-view truth: the agenda slot cards used to hardcode capacity 4 — a 6-person
// group showed "6/4", colored wrongly "full" at 4, and silently dropped players
// beyond #4. They must follow the slot's real max_participants.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { getSlotStatus, slotDisplayCapacity } from '@/components/agenda/slotStatus';
import { DayViewSlotCard } from '@/components/agenda/DayViewSlotCard';
import type { SlotWithBookings, BookedPlayer } from '@/lib/slotTypes';

const player = (i: number): BookedPlayer => ({
  id: `p${i}`,
  bookingId: `b${i}`,
  name: `Player ${i}`,
  status: 'confirmed',
  isGuest: false,
});

const slot = (over: Partial<SlotWithBookings>): SlotWithBookings => ({
  id: 's1',
  start_time: '2026-07-06T18:00:00Z',
  end_time: '2026-07-06T19:00:00Z',
  max_participants: 4,
  price: null,
  active_bookings: 0,
  pending_bookings: 0,
  is_past: false,
  is_public: true,
  cyclus_id: null,
  cyclus_name: null,
  booked_players: [],
  location_name: null,
  ...over,
});

describe('slot status follows real capacity', () => {
  it('a 6-capacity slot with 4 bookings is partial, not full', () => {
    expect(getSlotStatus(slot({ max_participants: 6, active_bookings: 4 }))).toBe('partial');
  });

  it('a 2-capacity slot with 2 bookings is full, not partial', () => {
    expect(getSlotStatus(slot({ max_participants: 2, active_bookings: 2 }))).toBe('full');
  });

  it('guards against a zero/absent capacity with the old default of 4', () => {
    expect(slotDisplayCapacity({ max_participants: 0 })).toBe(4);
    expect(getSlotStatus(slot({ max_participants: 0, active_bookings: 4 }))).toBe('full');
  });
});

describe('DayViewSlotCard renders real capacity', () => {
  it('shows X/max and every booked player, not just the first 4', () => {
    const players = [1, 2, 3, 4, 5, 6].map(player);
    render(
      <DayViewSlotCard
        slot={slot({ max_participants: 6, active_bookings: 6, booked_players: players })}
      />,
    );
    expect(screen.getByText(/\(6\/6\)/)).toBeInTheDocument();
    for (const p of players) {
      expect(screen.getByText(p.name)).toBeInTheDocument();
    }
  });

  it('a 2-person slot renders 2 seats and no empty extras', () => {
    render(
      <DayViewSlotCard
        slot={slot({ max_participants: 2, active_bookings: 1, booked_players: [player(1)] })}
      />,
    );
    expect(screen.getByText(/\(1\/2\)/)).toBeInTheDocument();
    // exactly one empty seat row remains
    expect(screen.getAllByText(/Empty slot|calendar\.emptySlot/)).toHaveLength(1);
  });
});
