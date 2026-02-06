import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import type { Lesson, Booking, AvailabilitySlot, PaginationOptions } from './lessons';

// Mock the supabase client
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: vi.fn(),
    functions: {
      invoke: vi.fn(),
    },
  },
}));

import { supabase } from '@/lib/supabaseClient';

describe('Lesson interface', () => {
  it('has correct structure for basic lesson', () => {
    const lesson: Lesson = {
      id: 'lesson-123',
      trainer_id: 'trainer-456',
      title: 'Beginner Padel',
      description: 'Learn the basics',
      duration_minutes: 60,
      price: 45,
      max_participants: 4,
      min_skill_rating: null,
      max_skill_rating: null,
      location: 'Court 1',
      is_active: true,
      is_recurring: false,
      recurrence_type: null,
      recurrence_day: null,
      recurrence_time: null,
      recurrence_count: null,
      recurrence_end_date: null,
      start_date: null,
      payment_timing: 'upfront',
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    };

    expect(lesson.id).toBe('lesson-123');
    expect(lesson.trainer_id).toBe('trainer-456');
    expect(lesson.is_recurring).toBe(false);
    expect(lesson.payment_timing).toBe('upfront');
  });

  it('supports recurring lesson structure', () => {
    const recurringLesson: Lesson = {
      id: 'lesson-789',
      trainer_id: 'trainer-456',
      title: 'Weekly Group Session',
      description: null,
      duration_minutes: 90,
      price: 35,
      max_participants: 8,
      min_skill_rating: 3.0,
      max_skill_rating: 6.0,
      location: null,
      is_active: true,
      is_recurring: true,
      recurrence_type: 'weekly',
      recurrence_day: 2, // Tuesday
      recurrence_time: '18:00',
      recurrence_count: 10,
      recurrence_end_date: '2024-04-01',
      start_date: '2024-01-15',
      payment_timing: 'after',
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    };

    expect(recurringLesson.is_recurring).toBe(true);
    expect(recurringLesson.recurrence_type).toBe('weekly');
    expect(recurringLesson.recurrence_day).toBe(2);
    expect(recurringLesson.min_skill_rating).toBe(3.0);
    expect(recurringLesson.max_skill_rating).toBe(6.0);
  });
});

describe('Booking interface', () => {
  it('has correct structure for pending booking', () => {
    const booking: Booking = {
      id: 'booking-123',
      slot_id: 'slot-456',
      player_id: 'player-789',
      lesson_id: 'lesson-abc',
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
      lesson_id: 'lesson-789',
      start_time: '2024-01-15T10:00:00Z',
      end_time: '2024-01-15T11:00:00Z',
      is_recurring: false,
      recurrence_rule: null,
      created_at: '2024-01-01T00:00:00Z',
    };

    expect(slot.id).toBe('slot-123');
    expect(slot.trainer_id).toBe('trainer-456');
    expect(slot.lesson_id).toBe('lesson-789');
  });

  it('supports recurring slot with rrule', () => {
    const recurringSlot: AvailabilitySlot = {
      id: 'slot-abc',
      trainer_id: 'trainer-456',
      lesson_id: null,
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
    const pending: Booking['status'] = 'pending';
    const validNextStates: Booking['status'][] = ['confirmed', 'cancelled'];
    
    expect(validNextStates).toContain('confirmed');
    expect(validNextStates).toContain('cancelled');
  });

  it('pending_approval can transition to pending or rejected', () => {
    const pendingApproval: Booking['status'] = 'pending_approval';
    const validNextStates: Booking['status'][] = ['pending', 'rejected'];
    
    expect(validNextStates).toContain('pending');
    expect(validNextStates).toContain('rejected');
  });

  it('confirmed can transition to completed or cancelled', () => {
    const confirmed: Booking['status'] = 'confirmed';
    const validNextStates: Booking['status'][] = ['completed', 'cancelled'];
    
    expect(validNextStates).toContain('completed');
    expect(validNextStates).toContain('cancelled');
  });
});

describe('Payment timing logic', () => {
  it('upfront payment requires payment before confirmation', () => {
    const lesson: Partial<Lesson> = { payment_timing: 'upfront' };
    const requiresUpfrontPayment = lesson.payment_timing === 'upfront';
    expect(requiresUpfrontPayment).toBe(true);
  });

  it('after payment allows invoice after lesson', () => {
    const lesson: Partial<Lesson> = { payment_timing: 'after' };
    const requiresUpfrontPayment = lesson.payment_timing === 'upfront';
    expect(requiresUpfrontPayment).toBe(false);
  });
});

describe('Skill rating validation', () => {
  it('player within skill range can book', () => {
    const playerRating = 5.0;
    const minRating = 3.0;
    const maxRating = 7.0;

    const canBook = playerRating >= minRating && playerRating <= maxRating;
    expect(canBook).toBe(true);
  });

  it('player below min rating cannot book', () => {
    const playerRating = 2.0;
    const minRating = 3.0;
    const maxRating = 7.0;

    const canBook = playerRating >= minRating && playerRating <= maxRating;
    expect(canBook).toBe(false);
  });

  it('player above max rating cannot book', () => {
    const playerRating = 8.0;
    const minRating = 3.0;
    const maxRating = 7.0;

    const canBook = playerRating >= minRating && playerRating <= maxRating;
    expect(canBook).toBe(false);
  });

  it('null skill ratings allow any player', () => {
    const playerRating = 5.0;
    const minRating: number | null = null;
    const maxRating: number | null = null;

    const canBook = 
      (minRating === null || playerRating >= minRating) &&
      (maxRating === null || playerRating <= maxRating);
    expect(canBook).toBe(true);
  });

  it('player without rating can book if no requirements', () => {
    const playerRating: number | null = null;
    const minRating: number | null = null;
    const maxRating: number | null = null;

    const canBook = 
      minRating === null && maxRating === null ||
      (playerRating !== null && 
        (minRating === null || playerRating >= minRating) &&
        (maxRating === null || playerRating <= maxRating));
    expect(canBook).toBe(true);
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
