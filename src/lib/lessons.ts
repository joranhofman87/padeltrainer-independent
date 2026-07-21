import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';

/** Default seats for a slot when max_participants is unset (a padel court).
 *  Single source of truth so every surface agrees on a NULL-capacity slot. */
export const DEFAULT_MAX_PARTICIPANTS = 4;

/** Booking statuses that occupy a seat for capacity / open-spot calculations.
 *  pending_approval IS occupying — the player has requested the seat and is
 *  awaiting the trainer's decision, so it must not be overbookable. cancelled /
 *  cancelled_swap / rejected / completed do not hold a future seat. */
// SYNC: this allowlist is mirrored server-side and must be kept identical:
//  - the partial index `idx_bookings_slot_status` (migration 20260629120000) WHERE clause
//    (delete-guard hot path / findBookedSlotIds), and
//  - the five DB capacity counts — enforce_booking_slot_tier, book_slot_for_payment,
//    respond_to_priority_claim's two counts, and swap_member_booking — aligned to this list
//    in migration 20260702140000.
// If this set changes, update those predicates too or server occupancy will diverge from the app.
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

/**
 * Does this booking hold a seat RIGHT NOW, by the same rule the database uses?
 *
 * CAPACITY_OCCUPYING_STATUSES is only half the server predicate: every DB capacity count also
 * treats a `payment_pending` row with a LIVE hold as occupying (see get_public_slot_occupancy
 * and enforce_booking_slot_tier). A client that checks the statuses alone therefore undercounts
 * exactly while someone is at the payment screen — the window in which double-booking is most
 * likely. Public surfaces should prefer get_public_slot_occupancy; this exists for the
 * deploy-window fallback and for callers that already hold the rows.
 */
export function occupiesSeatNow(
  booking: { status?: string | null; hold_expires_at?: string | null } | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!booking) return false;
  if (isOccupyingStatus(booking.status)) return true;
  return booking.status === 'payment_pending'
    && Boolean(booking.hold_expires_at)
    && new Date(booking.hold_expires_at as string).getTime() > now.getTime();
}

/** Occupied seats using the FULL server predicate (statuses + live payment holds). */
export function countOccupiedSeatsNow(
  bookings: Array<{ status?: string | null; hold_expires_at?: string | null }> | null | undefined,
  now: Date = new Date(),
): number {
  return (bookings ?? []).filter((b) => occupiesSeatNow(b, now)).length;
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
