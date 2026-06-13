import { format } from 'date-fns';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';
import { fetchTrainerDisplayNamesByProfileIds } from '@/lib/trainerDisplayNames';

export type UnpaidRecipientType = 'player' | 'guest';
export type UnpaidSourceType = 'cyclus' | 'slot';

/** One outstanding payment obligation (grouped bookings). */
export interface UnpaidBooking {
  /** Stable group key for UI selection. */
  id: string;
  bookingIds: string[];
  slotId: string;
  playerName: string;
  playerEmail: string;
  playerId: string | null;
  guestPlayerId: string | null;
  sessionDate: string;
  sessionTime: string;
  amount: number;
  cyclusName: string | null;
  cyclusId: string | null;
  sessionCount: number;
  isCycleGroup: boolean;
  reminderSentAt: string | null;
  trainerName: string;
}

export type UnpaidBookingRow = {
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
    cyclus_id: string | null;
    cyclus_name: string | null;
    price_per_session: number | null;
  };
};

type MappedUnpaidLine = {
  bookingId: string;
  slotId: string;
  groupKey: string;
  recipientType: UnpaidRecipientType;
  recipientId: string;
  sourceType: UnpaidSourceType;
  sourceId: string;
  playerName: string;
  playerEmail: string;
  playerId: string | null;
  guestPlayerId: string | null;
  amount: number;
  cyclusName: string | null;
  cyclusId: string | null;
  reminderSentAt: string | null;
  trainerName: string;
  startTime: string;
  endTime: string;
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
    cyclus_id,
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

/** Per-booking outstanding amount; null when amount is missing or <= 0. */
export function calculateOutstandingAmount(
  paymentAmount: number | null | undefined,
  pricePerSession: number | null | undefined,
): number | null {
  const raw = paymentAmount ?? pricePerSession ?? null;
  if (raw == null || raw <= 0) return null;
  return raw;
}

/** Group key: recipient + cycle or single slot. */
export function getUnpaidBookingGroupKey(row: {
  player_id: string | null;
  guest_player_id: string | null;
  slot_id: string;
  availability_slots: { cyclus_id?: string | null };
}): string {
  const recipientType: UnpaidRecipientType = row.player_id ? 'player' : 'guest';
  const recipientId = row.player_id ?? row.guest_player_id ?? '';
  const cyclusId = row.availability_slots?.cyclus_id;
  if (cyclusId) {
    return `${recipientType}:${recipientId}:cyclus:${cyclusId}`;
  }
  return `${recipientType}:${recipientId}:slot:${row.slot_id}`;
}

export function mapUnpaidBookingRow(
  b: UnpaidBookingRow,
  trainerNameByProfileId?: Map<string, string>,
): MappedUnpaidLine | null {
  const slot = b.availability_slots;
  const amount = calculateOutstandingAmount(b.payment_amount, slot?.price_per_session);
  if (amount == null) return null;

  const profile = b.profiles;
  const guest = b.guest_players;
  const trainerId = slot?.trainer_id;
  const trainerName =
    (trainerId && trainerNameByProfileId?.get(trainerId)) || 'Trainer';
  const cyclusId = slot?.cyclus_id ?? null;

  return {
    bookingId: b.id,
    slotId: b.slot_id,
    groupKey: getUnpaidBookingGroupKey(b),
    recipientType: b.player_id ? 'player' : 'guest',
    recipientId: b.player_id ?? b.guest_player_id ?? '',
    sourceType: cyclusId ? 'cyclus' : 'slot',
    sourceId: cyclusId ?? b.slot_id,
    playerName: profile?.full_name || guest?.full_name || 'Unknown',
    playerEmail: profile?.email || guest?.email || '',
    playerId: b.player_id,
    guestPlayerId: b.guest_player_id,
    amount,
    cyclusName: slot?.cyclus_name || null,
    cyclusId,
    reminderSentAt: b.reminder_sent_at,
    trainerName,
    startTime: slot.start_time,
    endTime: slot.end_time,
  };
}

function latestReminderSentAt(lines: MappedUnpaidLine[]): string | null {
  let latest: string | null = null;
  for (const line of lines) {
    if (!line.reminderSentAt) continue;
    if (!latest || new Date(line.reminderSentAt) > new Date(latest)) {
      latest = line.reminderSentAt;
    }
  }
  return latest;
}

/** Group mapped lines into one dashboard row per payment obligation. */
export function groupUnpaidBookingsByPaymentObligation(lines: MappedUnpaidLine[]): UnpaidBooking[] {
  const byKey = new Map<string, MappedUnpaidLine[]>();
  for (const line of lines) {
    const existing = byKey.get(line.groupKey) || [];
    existing.push(line);
    byKey.set(line.groupKey, existing);
  }

  const obligations: Array<{ item: UnpaidBooking; firstStart: string }> = [];

  for (const [groupKey, groupLines] of byKey) {
    const sorted = [...groupLines].sort(
      (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
    );
    const first = sorted[0];
    const isCycleGroup = first.sourceType === 'cyclus';
    const totalAmount = sorted.reduce((sum, l) => sum + l.amount, 0);

    obligations.push({
      firstStart: first.startTime,
      item: {
        id: groupKey,
        bookingIds: sorted.map((l) => l.bookingId),
        slotId: first.slotId,
        playerName: first.playerName,
        playerEmail: first.playerEmail,
        playerId: first.playerId,
        guestPlayerId: first.guestPlayerId,
        sessionDate: format(new Date(first.startTime), 'dd MMM yyyy'),
        sessionTime: `${format(new Date(first.startTime), 'HH:mm')} - ${format(new Date(first.endTime), 'HH:mm')}`,
        amount: totalAmount,
        cyclusName: first.cyclusName,
        cyclusId: first.cyclusId,
        sessionCount: sorted.length,
        isCycleGroup,
        reminderSentAt: latestReminderSentAt(sorted),
        trainerName: first.trainerName,
      },
    });
  }

  return obligations
    .sort((a, b) => new Date(a.firstStart).getTime() - new Date(b.firstStart).getTime())
    .map((o) => o.item);
}

/** HTML snippet for payment_reminder email body. */
export function buildUnpaidReminderSessionsHtml(booking: UnpaidBooking): string {
  if (booking.isCycleGroup) {
    const label = booking.cyclusName || 'Cycle';
    return `<p><strong>${label}</strong> — ${booking.sessionCount} session${booking.sessionCount === 1 ? '' : 's'}, from ${booking.sessionDate} — €${booking.amount.toFixed(2)}</p>`;
  }
  return `<p><strong>${booking.sessionDate}</strong> ${booking.sessionTime}${booking.cyclusName ? ` (${booking.cyclusName})` : ''} — €${booking.amount.toFixed(2)}</p>`;
}

export async function markUnpaidBookingsPaid(
  bookingIds: string[],
  client: SupabaseClient<Database> = supabase,
): Promise<{ error: Error | null }> {
  if (bookingIds.length === 0) return { error: null };
  // Canonical paid transition (mirrors markInvoicePaidAndSyncBookings / the
  // Mollie webhook): paid + confirmed so the player and staff surfaces agree.
  // Never resurrect a cancelled booking.
  const { error } = await client
    .from('bookings')
    .update({ payment_status: 'paid', status: 'confirmed', paid_at: new Date().toISOString() })
    .in('id', bookingIds)
    .neq('status', 'cancelled')
    .neq('status', 'cancelled_swap');
  return { error: error ? new Error(error.message) : null };
}

export async function setUnpaidBookingsReminderSent(
  bookingIds: string[],
  client: SupabaseClient<Database> = supabase,
): Promise<{ error: Error | null }> {
  if (bookingIds.length === 0) return { error: null };
  const sentAt = new Date().toISOString();
  const { error } = await client
    .from('bookings')
    .update({ reminder_sent_at: sentAt })
    .in('id', bookingIds);
  return { error: error ? new Error(error.message) : null };
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
  const lines = sorted
    .map((row) => mapUnpaidBookingRow(row, trainerNameByProfileId))
    .filter((line): line is MappedUnpaidLine => line != null);

  return groupUnpaidBookingsByPaymentObligation(lines);
}
