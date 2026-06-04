import { format } from 'date-fns';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';
import { fetchTrainerDisplayNamesByProfileIds } from '@/lib/trainerDisplayNames';

export interface UnpaidBooking {
  id: string;
  slotId: string;
  playerName: string;
  playerEmail: string;
  playerId: string | null;
  guestPlayerId: string | null;
  sessionDate: string;
  sessionTime: string;
  amount: number | null;
  cyclusName: string | null;
  reminderSentAt: string | null;
  trainerName: string;
}

type UnpaidBookingRow = {
  id: string;
  slot_id: string;
  payment_amount: number | null;
  reminder_sent_at: string | null;
  player_id: string | null;
  guest_player_id: string | null;
  profiles: { full_name: string | null; email: string | null } | null;
  guest_players: { full_name: string | null; email: string | null } | null;
  availability_slots: {
    start_time: string;
    end_time: string;
    trainer_id: string | null;
    cyclus_name: string | null;
    price_per_session: number | null;
  };
};

/** Bookings select without nested trainer_profiles embed; trainer names loaded separately. */
export const UNPAID_BOOKINGS_SELECT = `
  id,
  slot_id,
  payment_status,
  payment_amount,
  reminder_sent_at,
  player_id,
  guest_player_id,
  profiles:player_id (full_name, email),
  guest_players:guest_player_id (full_name, email),
  availability_slots!inner (
    start_time,
    end_time,
    trainer_id,
    cyclus_name,
    price_per_session
  )
`;

export const unpaidBookingsQueryOptions = {
  staleTime: 2 * 60 * 1000,
  retry: false as const,
};

/** Sort unpaid booking rows by embedded slot start time (ascending). */
export function sortBookingsBySlotStartTime<T extends { availability_slots: { start_time: string } }>(
  rows: T[],
): T[] {
  return [...rows].sort(
    (a, b) =>
      new Date(a.availability_slots.start_time).getTime() -
      new Date(b.availability_slots.start_time).getTime(),
  );
}

export function mapUnpaidBookingRow(
  b: UnpaidBookingRow,
  trainerNameByProfileId?: Map<string, string>,
): UnpaidBooking {
  const slot = b.availability_slots;
  const profile = b.profiles;
  const guest = b.guest_players;
  const trainerId = slot?.trainer_id;
  const trainerName =
    (trainerId && trainerNameByProfileId?.get(trainerId)) || 'Trainer';

  return {
    id: b.id,
    slotId: b.slot_id,
    playerName: profile?.full_name || guest?.full_name || 'Unknown',
    playerEmail: profile?.email || guest?.email || '',
    playerId: b.player_id,
    guestPlayerId: b.guest_player_id,
    sessionDate: format(new Date(slot.start_time), 'dd MMM yyyy'),
    sessionTime: `${format(new Date(slot.start_time), 'HH:mm')} - ${format(new Date(slot.end_time), 'HH:mm')}`,
    amount: b.payment_amount || slot.price_per_session || null,
    cyclusName: slot.cyclus_name || null,
    reminderSentAt: b.reminder_sent_at,
    trainerName,
  };
}

export async function fetchUnpaidBookingsData(
  trainerId?: string | null,
  academyId?: string | null,
  client: SupabaseClient<Database> = supabase,
): Promise<UnpaidBooking[]> {
  let trainerIds: string[] = [];

  if (academyId) {
    const { data: academyTrainers } = await client
      .from('academy_trainers')
      .select('trainer_profile_id')
      .eq('academy_profile_id', academyId)
      .eq('status', 'active');
    trainerIds = academyTrainers?.map((t) => t.trainer_profile_id) || [];
  } else if (trainerId) {
    trainerIds = [trainerId];
  }

  const normalizedTrainerIds = trainerIds.filter((id): id is string => !!id?.trim());
  if (normalizedTrainerIds.length === 0) return [];

  const { data, error } = await client
    .from('bookings')
    .select(UNPAID_BOOKINGS_SELECT)
    .in('availability_slots.trainer_id', normalizedTrainerIds)
    .eq('payment_status', 'pending')
    .in('status', ['confirmed', 'pending'])
    .gte('availability_slots.start_time', new Date().toISOString());

  if (error) {
    logger.error('Failed to load unpaid bookings', new Error(error.message), {
      component: 'UnpaidBookingsCard',
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    return [];
  }

  const rows = (data || []) as UnpaidBookingRow[];
  const slotTrainerIds = [
    ...new Set(rows.map((r) => r.availability_slots?.trainer_id).filter((id): id is string => !!id)),
  ];
  const trainerNameByProfileId = await fetchTrainerDisplayNamesByProfileIds(
    slotTrainerIds,
    client,
    'UnpaidBookingsCard',
  );

  const sorted = sortBookingsBySlotStartTime(rows);
  return sorted.map((row) => mapUnpaidBookingRow(row, trainerNameByProfileId));
}
