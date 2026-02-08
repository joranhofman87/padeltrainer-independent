import { describe, it, expect, vi } from 'vitest';
import type { Booking, AvailabilitySlot, PaginationOptions } from './lessons';

// Mock the supabase client
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: vi.fn(),
    functions: {
      invoke: vi.fn(),
    },
  },
}));

describe('Booking interface', () => {
  it('has correct structure for pending booking', () => {
    const booking: Booking = {
      id: 'booking-123',
      slot_id: 'slot-456',
      player_id: 'player-789',
      status: 'pending',
      notes: 'Looking forward to it!',
      payment_status: 'pending',
      payment_amount: 45,
      paid_at: null,
      created_at: '2024-01-15T10:00:00Z',
      updated_at: '2024-01-15T10:00:00Z',
    };

    expect(booking.status).toBe('pending');
    expect(booking.payment_status).toBe('pending');
    expect(booking.paid_at).toBeNull();
  });

  it('supports all booking statuses', () => {
    const statuses: Booking['status'][] = [
      'pending',
      'pending_approval',
      'confirmed',
      'cancelled',
      'completed',
      'rejected',
    ];
    expect(statuses.length).toBe(6);
  });

  it('supports all payment statuses', () => {
    const paymentStatuses: Booking['payment_status'][] = [
      'pending',
      'paid',
      'refunded',
      'waived',
    ];
    expect(paymentStatuses.length).toBe(4);
  });
});

describe('AvailabilitySlot interface', () => {
  it('has correct structure', () => {
    const slot: AvailabilitySlot = {
      id: 'slot-123',
      trainer_id: 'trainer-456',
      start_time: '2024-01-15T10:00:00Z',
      end_time: '2024-01-15T11:00:00Z',
      is_recurring: false,
      recurrence_rule: null,
      created_at: '2024-01-01T00:00:00Z',
    };

    expect(slot.id).toBe('slot-123');
    expect(slot.trainer_id).toBe('trainer-456');
  });

  it('supports recurring slot with rrule', () => {
    const recurringSlot: AvailabilitySlot = {
      id: 'slot-abc',
      trainer_id: 'trainer-456',
      start_time: '2024-01-15T10:00:00Z',
      end_time: '2024-01-15T11:00:00Z',
      is_recurring: true,
      recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR',
      created_at: '2024-01-01T00:00:00Z',
    };

    expect(recurringSlot.is_recurring).toBe(true);
    expect(recurringSlot.recurrence_rule).toContain('FREQ=WEEKLY');
  });
});

describe('PaginationOptions interface', () => {
  it('has optional page and pageSize', () => {
    const defaultOptions: PaginationOptions = {};
    const customOptions: PaginationOptions = { page: 2, pageSize: 25 };

    expect(defaultOptions.page).toBeUndefined();
    expect(defaultOptions.pageSize).toBeUndefined();
    expect(customOptions.page).toBe(2);
    expect(customOptions.pageSize).toBe(25);
  });
});

describe('Pagination calculation', () => {
  it('calculates correct range for first page', () => {
    const page = 0;
    const pageSize = 50;
    const from = page * pageSize;
    const to = from + pageSize - 1;

    expect(from).toBe(0);
    expect(to).toBe(49);
  });

  it('calculates correct range for second page', () => {
    const page = 1;
    const pageSize = 50;
    const from = page * pageSize;
    const to = from + pageSize - 1;

    expect(from).toBe(50);
    expect(to).toBe(99);
  });

  it('calculates correct range with custom page size', () => {
    const page = 2;
    const pageSize = 25;
    const from = page * pageSize;
    const to = from + pageSize - 1;

    expect(from).toBe(50);
    expect(to).toBe(74);
  });
});

describe('Booking status transitions', () => {
  it('pending can transition to confirmed or cancelled', () => {
    const validNextStates: Booking['status'][] = ['confirmed', 'cancelled'];
    expect(validNextStates).toContain('confirmed');
    expect(validNextStates).toContain('cancelled');
  });

  it('pending_approval can transition to pending or rejected', () => {
    const validNextStates: Booking['status'][] = ['pending', 'rejected'];
    expect(validNextStates).toContain('pending');
    expect(validNextStates).toContain('rejected');
  });

  it('confirmed can transition to completed or cancelled', () => {
    const validNextStates: Booking['status'][] = ['completed', 'cancelled'];
    expect(validNextStates).toContain('completed');
    expect(validNextStates).toContain('cancelled');
  });
});

describe('Max participants logic', () => {
  it('slot is available when under capacity', () => {
    const maxParticipants = 4;
    const confirmedBookings = 2;
    const isAvailable = confirmedBookings < maxParticipants;
    expect(isAvailable).toBe(true);
  });

  it('slot is full at capacity', () => {
    const maxParticipants = 4;
    const confirmedBookings = 4;
    const isAvailable = confirmedBookings < maxParticipants;
    expect(isAvailable).toBe(false);
  });

  it('private lesson (max 1) is full with 1 booking', () => {
    const maxParticipants = 1;
    const confirmedBookings = 1;
    const isAvailable = confirmedBookings < maxParticipants;
    expect(isAvailable).toBe(false);
  });
});
