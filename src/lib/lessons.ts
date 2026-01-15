import { supabase } from '@/integrations/supabase/client';

export interface Lesson {
  id: string;
  trainer_id: string;
  title: string;
  description: string | null;
  duration_minutes: number;
  price: number;
  max_participants: number;
  min_skill_rating: number | null;
  max_skill_rating: number | null;
  location: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface AvailabilitySlot {
  id: string;
  trainer_id: string;
  lesson_id: string | null;
  start_time: string;
  end_time: string;
  is_recurring: boolean;
  recurrence_rule: string | null;
  created_at: string;
}

export interface Booking {
  id: string;
  slot_id: string;
  player_id: string;
  lesson_id: string | null;
  status: 'pending' | 'confirmed' | 'cancelled' | 'completed';
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// Lesson CRUD
export async function createLesson(trainerId: string, data: Omit<Lesson, 'id' | 'trainer_id' | 'created_at' | 'updated_at'>) {
  return supabase
    .from('lessons')
    .insert({
      trainer_id: trainerId,
      ...data,
    })
    .select()
    .single();
}

export async function getTrainerLessons(trainerId: string) {
  return supabase
    .from('lessons')
    .select('*')
    .eq('trainer_id', trainerId)
    .order('created_at', { ascending: false });
}

export async function updateLesson(lessonId: string, data: Partial<Lesson>) {
  return supabase
    .from('lessons')
    .update(data)
    .eq('id', lessonId)
    .select()
    .single();
}

export async function deleteLesson(lessonId: string) {
  return supabase
    .from('lessons')
    .delete()
    .eq('id', lessonId);
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
    .select('*, lessons(*)')
    .eq('trainer_id', trainerId)
    .gte('start_time', new Date().toISOString())
    .order('start_time', { ascending: true });
}

export async function getAvailableSlotsForTrainer(trainerId: string) {
  // Get slots that don't have confirmed bookings
  const { data: slots, error } = await supabase
    .from('availability_slots')
    .select(`
      *,
      lessons(*),
      bookings(id, status)
    `)
    .eq('trainer_id', trainerId)
    .gte('start_time', new Date().toISOString())
    .order('start_time', { ascending: true });

  if (error) return { data: null, error };

  // Filter out slots that are fully booked
  const availableSlots = slots?.filter(slot => {
    const confirmedBookings = slot.bookings?.filter((b: any) => b.status === 'confirmed' || b.status === 'pending') || [];
    const maxParticipants = slot.lessons?.max_participants || 1;
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
export async function createBooking(playerId: string, slotId: string, lessonId: string | null, notes?: string) {
  return supabase
    .from('bookings')
    .insert({
      player_id: playerId,
      slot_id: slotId,
      lesson_id: lessonId,
      notes,
    })
    .select()
    .single();
}

export async function getPlayerBookings(playerId: string) {
  return supabase
    .from('bookings')
    .select(`
      *,
      availability_slots(*, trainer_profiles(*, profiles(*))),
      lessons(*)
    `)
    .eq('player_id', playerId)
    .order('created_at', { ascending: false });
}

export async function getTrainerBookings(trainerId: string) {
  return supabase
    .from('bookings')
    .select(`
      *,
      availability_slots!inner(*),
      lessons(*),
      profiles:player_id(*)
    `)
    .eq('availability_slots.trainer_id', trainerId)
    .order('created_at', { ascending: false });
}

export async function updateBookingStatus(bookingId: string, status: Booking['status']) {
  return supabase
    .from('bookings')
    .update({ status })
    .eq('id', bookingId)
    .select()
    .single();
}

export async function cancelBooking(bookingId: string) {
  return updateBookingStatus(bookingId, 'cancelled');
}
