import { supabase } from '@/lib/supabaseClient';
import { TRAINING_BOOKING_STATUSES } from '@/lib/academyPlayerTrainingLocations';

export type TrainerPlayerTrainingLocation = {
  location_id: string;
  location_name: string;
  session_count: number;
  last_session_at: string | null;
};

/** Training locations derived from this trainer's booked slots only. */
export async function fetchTrainerPlayerTrainingLocations(params: {
  trainerProfileId: string;
  guestPlayerId?: string | null;
  profileId?: string | null;
  bookingStatuses?: readonly string[];
}): Promise<TrainerPlayerTrainingLocation[]> {
  const statuses = new Set(params.bookingStatuses ?? TRAINING_BOOKING_STATUSES);

  let bookingsQuery = supabase
    .from('bookings')
    .select('id, status, slot_id, guest_player_id, player_id');

  if (params.guestPlayerId) {
    bookingsQuery = bookingsQuery.eq('guest_player_id', params.guestPlayerId);
  } else if (params.profileId) {
    bookingsQuery = bookingsQuery.eq('player_id', params.profileId);
  } else {
    return [];
  }

  const { data: bookings, error: bookingsError } = await bookingsQuery;
  if (bookingsError) throw bookingsError;
  if (!bookings?.length) return [];

  const slotIds = Array.from(new Set(bookings.map((b) => b.slot_id).filter(Boolean)));
  const { data: slots, error: slotsError } = await supabase
    .from('availability_slots')
    .select('id, location_id, start_time')
    .in('id', slotIds)
    .eq('trainer_id', params.trainerProfileId);

  if (slotsError) throw slotsError;
  if (!slots?.length) return [];

  const locationIds = Array.from(
    new Set((slots || []).map((s) => s.location_id).filter((id): id is string => Boolean(id))),
  );

  const locationNameById = new Map<string, string>();
  if (locationIds.length) {
    const { data: locs, error: locsError } = await supabase
      .from('locations')
      .select('id, name')
      .in('id', locationIds);
    if (locsError) throw locsError;
    locs?.forEach((l) => locationNameById.set(l.id, l.name));
  }

  const slotById = new Map((slots || []).map((s) => [s.id, s]));
  const byLocation = new Map<string, TrainerPlayerTrainingLocation>();

  for (const booking of bookings) {
    if (!statuses.has(booking.status)) continue;
    const slot = slotById.get(booking.slot_id);
    if (!slot?.location_id) continue;

    const name = locationNameById.get(slot.location_id);
    if (!name) continue;

    const existing = byLocation.get(slot.location_id);
    if (!existing) {
      byLocation.set(slot.location_id, {
        location_id: slot.location_id,
        location_name: name,
        session_count: 1,
        last_session_at: slot.start_time,
      });
      continue;
    }

    existing.session_count += 1;
    if (
      slot.start_time &&
      (!existing.last_session_at || slot.start_time > existing.last_session_at)
    ) {
      existing.last_session_at = slot.start_time;
    }
  }

  return Array.from(byLocation.values()).sort((a, b) => {
    if (b.session_count !== a.session_count) return b.session_count - a.session_count;
    return a.location_name.localeCompare(b.location_name);
  });
}
