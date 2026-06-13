import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';

/** Default seats for a slot when max_participants is unset (a padel court).
 *  Single source of truth so every surface agrees on a NULL-capacity slot. */
export const DEFAULT_MAX_PARTICIPANTS = 4;

/** Booking statuses that occupy a seat for capacity / open-spot calculations.
 *  pending_approval IS occupying — the player has requested the seat and is
 *  awaiting the trainer's decision, so it must not be overbookable. cancelled /
 *  cancelled_swap / rejected / completed do not hold a future seat. */
export const CAPACITY_OCCUPYING_STATUSES = ['confirmed', 'pending', 'pending_approval'] as const;

export function isOccupyingStatus(status: string | null | undefined): boolean {
  return !!status && (CAPACITY_OCCUPYING_STATUSES as readonly string[]).includes(status);
}

/** Resolve a slot's capacity, applying the single shared default. */
export function getSlotCapacity(slot: { max_participants?: number | null } | null | undefined): number {
  return slot?.max_participants ?? DEFAULT_MAX_PARTICIPANTS;
}

/** Count occupied seats among a slot's bookings (confirmed + pending + pending_approval). */
export function countOccupiedSeats(
  bookings: Array<{ status?: string | null }> | null | undefined,
): number {
  return (bookings ?? []).filter((b) => isOccupyingStatus(b.status)).length;
}

export interface Booking {
  id: string;
  slot_id: string;
  player_id: string;
  status: 'pending' | 'pending_approval' | 'confirmed' | 'cancelled' | 'completed' | 'rejected';
  notes: string | null;
  payment_status: 'pending' | 'paid' | 'refunded' | 'waived';
  payment_amount: number | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AvailabilitySlot {
  id: string;
  trainer_id: string;
  start_time: string;
  end_time: string;
  is_recurring: boolean;
  recurrence_rule: string | null;
  created_at: string;
}

// Availability CRUD
export async function createAvailabilitySlot(trainerId: string, data: Omit<AvailabilitySlot, 'id' | 'trainer_id' | 'created_at'>) {
  return supabase
    .from('availability_slots')
    .insert({
      trainer_id: trainerId,
      ...data,
    })
    .select()
    .single();
}

export async function getTrainerAvailability(trainerId: string) {
  return supabase
    .from('availability_slots')
    .select('*')
    .eq('trainer_id', trainerId)
    .gte('start_time', new Date().toISOString())
    .order('start_time', { ascending: true });
}

export async function getAvailableSlotsForTrainer(trainerId: string) {
  const { data: slots, error } = await supabase
    .from('availability_slots')
    .select(`
      *,
      bookings(id, status)
    `)
    .eq('trainer_id', trainerId)
    .gte('start_time', new Date().toISOString())
    .order('start_time', { ascending: true });

  if (error) return { data: null, error };

  const availableSlots = slots?.filter(slot => {
    return countOccupiedSeats(slot.bookings) < getSlotCapacity(slot);
  });

  return { data: availableSlots, error: null };
}

export async function deleteAvailabilitySlot(slotId: string) {
  return supabase
    .from('availability_slots')
    .delete()
    .eq('id', slotId);
}

// Booking CRUD
export interface PaginationOptions {
  page?: number;
  pageSize?: number;
}

export async function createBooking(playerId: string, slotId: string, notes?: string) {
  return supabase
    .from('bookings')
    .insert({
      player_id: playerId,
      slot_id: slotId,
      notes,
    })
    .select()
    .single();
}

export async function getPlayerBookings(
  playerId: string, 
  options: PaginationOptions = {}
) {
  const { page = 0, pageSize = 50 } = options;
  const from = page * pageSize;
  const to = from + pageSize - 1;

  return supabase
    .from('bookings')
    .select(`
      *,
      availability_slots(*)
    `, { count: 'exact' })
    .eq('player_id', playerId)
    .order('created_at', { ascending: false })
    .range(from, to);
}

export async function getTrainerBookings(
  trainerId: string,
  options: PaginationOptions = {}
) {
  const { page = 0, pageSize = 50 } = options;
  const from = page * pageSize;
  const to = from + pageSize - 1;

  return supabase
    .from('bookings')
    .select(`
      *,
      availability_slots!inner(*),
      profiles:player_id(*)
    `, { count: 'exact' })
    .eq('availability_slots.trainer_id', trainerId)
    .order('created_at', { ascending: false })
    .range(from, to);
}

export async function updateBookingStatus(bookingId: string, status: Booking['status']) {
  const result = await supabase
    .from('bookings')
    .update({ status })
    .eq('id', bookingId)
    .select()
    .single();

  if (result.data && (status === 'confirmed' || status === 'cancelled')) {
    try {
      await supabase.functions.invoke('sync-calendar-event', {
        body: { 
          booking_id: bookingId, 
          action: status === 'confirmed' ? 'create' : 'delete' 
        },
      });
    } catch (e) {
      logger.warn('Calendar sync failed (non-blocking)', { error: e, component: 'lessons' });
    }
  }

  return result;
}

export async function cancelBooking(bookingId: string) {
  return updateBookingStatus(bookingId, 'cancelled');
}

export async function approveBookingRequest(bookingId: string) {
  return supabase
    .from('bookings')
    .update({ status: 'pending' })
    .eq('id', bookingId)
    .select()
    .single();
}

export async function rejectBookingRequest(bookingId: string) {
  return supabase
    .from('bookings')
    .update({ status: 'rejected' })
    .eq('id', bookingId)
    .select()
    .single();
}

export async function confirmBookingAfterApproval(bookingId: string) {
  return supabase
    .from('bookings')
    .update({ 
      status: 'confirmed',
      payment_status: 'pending' 
    })
    .eq('id', bookingId)
    .select()
    .single();
}
