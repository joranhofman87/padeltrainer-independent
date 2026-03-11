import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';

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
    const confirmedBookings = slot.bookings?.filter((b: { id: string; status: string }) => b.status === 'confirmed' || b.status === 'pending') || [];
    const maxParticipants = slot.max_participants ?? 4;
    return confirmedBookings.length < maxParticipants;
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
