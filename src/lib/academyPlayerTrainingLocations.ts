import { supabase } from '@/lib/supabaseClient';

export type PlayerTrainingLocation = {
  location_id: string;
  location_name: string;
  session_count: number;
  last_session_at: string | null;
};

export const TRAINING_BOOKING_STATUSES = ['confirmed', 'completed'] as const;

export type TrainingBookingRow = {
  booking_id: string;
  booking_status: string;
  slot_id: string;
  slot_trainer_id: string | null;
  slot_academy_profile_id: string | null;
  location_id: string | null;
  location_name: string | null;
  start_time: string | null;
  /** Ignored — must never influence aggregation */
  profiles_location?: string | null;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Reject free-text or unknown location ids for preferred-club edits. */
export function validatePreferredLocationId(
  locationId: string | null | undefined,
  allowedLocationIds: ReadonlySet<string>,
): string | null {
  const trimmed = locationId?.trim();
  if (!trimmed) return null;
  if (!isUuid(trimmed)) {
    throw new Error('freeTextLocationNotAllowed');
  }
  if (!allowedLocationIds.has(trimmed)) {
    throw new Error('locationNotInAcademy');
  }
  return trimmed;
}

export function aggregatePlayerTrainingLocations(
  rows: TrainingBookingRow[],
  options: {
    academyProfileId: string;
    academyLocationIds: ReadonlySet<string>;
    academyTrainerIds: ReadonlySet<string>;
    bookingStatuses?: readonly string[];
  },
): PlayerTrainingLocation[] {
  const statuses = new Set(options.bookingStatuses ?? TRAINING_BOOKING_STATUSES);
  const byLocation = new Map<string, PlayerTrainingLocation>();

  for (const row of rows) {
    // profiles.location and other free-text sources are never read here.
    void row.profiles_location;

    if (!row.location_id || !isUuid(row.location_id)) continue;
    if (!options.academyLocationIds.has(row.location_id)) continue;
    if (!statuses.has(row.booking_status)) continue;

    const academyScoped =
      row.slot_academy_profile_id === options.academyProfileId ||
      (row.slot_trainer_id != null && options.academyTrainerIds.has(row.slot_trainer_id));
    if (!academyScoped) continue;

    const name = row.location_name?.trim();
    if (!name) continue;

    const existing = byLocation.get(row.location_id);
    if (!existing) {
      byLocation.set(row.location_id, {
        location_id: row.location_id,
        location_name: name,
        session_count: 1,
        last_session_at: row.start_time,
      });
      continue;
    }

    existing.session_count += 1;
    if (
      row.start_time &&
      (!existing.last_session_at || row.start_time > existing.last_session_at)
    ) {
      existing.last_session_at = row.start_time;
    }
  }

  return Array.from(byLocation.values()).sort((a, b) => {
    if (b.session_count !== a.session_count) return b.session_count - a.session_count;
    return a.location_name.localeCompare(b.location_name);
  });
}

export async function fetchAcademyLocationIds(academyProfileId: string): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('academy_locations')
    .select('location_id')
    .eq('academy_profile_id', academyProfileId)
    .eq('is_active', true);

  if (error) throw error;
  return new Set((data || []).map((r) => r.location_id).filter(Boolean));
}

export async function fetchAcademyTrainerIds(academyProfileId: string): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('academy_trainers')
    .select('trainer_profile_id')
    .eq('academy_profile_id', academyProfileId)
    .eq('status', 'active');

  if (error) throw error;
  return new Set((data || []).map((r) => r.trainer_profile_id).filter(Boolean));
}

export async function fetchPlayerTrainingLocations(params: {
  academyProfileId: string;
  guestPlayerId?: string | null;
  profileId?: string | null;
  bookingStatuses?: readonly string[];
}): Promise<PlayerTrainingLocation[]> {
  const [academyLocationIds, academyTrainerIds] = await Promise.all([
    fetchAcademyLocationIds(params.academyProfileId),
    fetchAcademyTrainerIds(params.academyProfileId),
  ]);

  if (academyLocationIds.size === 0 || academyTrainerIds.size === 0) {
    return [];
  }

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
    .select('id, trainer_id, academy_profile_id, location_id, start_time')
    .in('id', slotIds);

  if (slotsError) throw slotsError;

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

  const rows: TrainingBookingRow[] = bookings.map((b) => {
    const slot = slotById.get(b.slot_id);
    const locationId = slot?.location_id ?? null;
    return {
      booking_id: b.id,
      booking_status: b.status,
      slot_id: b.slot_id,
      slot_trainer_id: slot?.trainer_id ?? null,
      slot_academy_profile_id: slot?.academy_profile_id ?? null,
      location_id: locationId,
      location_name: locationId ? locationNameById.get(locationId) ?? null : null,
      start_time: slot?.start_time ?? null,
      profiles_location: null,
    };
  });

  return aggregatePlayerTrainingLocations(rows, {
    academyProfileId: params.academyProfileId,
    academyLocationIds,
    academyTrainerIds,
    bookingStatuses: params.bookingStatuses,
  });
}
