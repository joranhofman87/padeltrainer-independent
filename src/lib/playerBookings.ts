import { supabase } from '@/lib/supabaseClient';
import { fetchTrainerDisplayNamesByProfileIds } from '@/lib/trainerDisplayNames';

/**
 * Single source of truth for a player's bookings.
 *
 * Both the dashboard and the bookings page route through this so they can never
 * disagree on payment/status: we cross-reference the player's *paid* invoices and
 * override `payment_status` (and flip a `pending` booking to `confirmed`) when a
 * booking is covered by a paid invoice. Previously the dashboard skipped this
 * override, so the same booking could read "pending" there and "paid" on the
 * bookings page.
 */
export interface PlayerBooking {
  id: string;
  slot_id: string;
  status: string;
  payment_status: string | null;
  paid_externally: boolean | null;
  notes: string | null;
  created_at: string;
  /** Slot fields, flattened for callers; null when the slot was later made private. */
  start_time: string | null;
  end_time: string | null;
  trainer_id: string | null;
  trainer_name: string;
  location_name: string | null;
  cyclus_name: string | null;
  price_per_session: number | null;
}

interface RawSlot {
  start_time: string | null;
  end_time: string | null;
  trainer_id: string | null;
  price_per_session: number | null;
  cyclus_name: string | null;
  locations: { name: string } | null;
}

interface RawBookingRow {
  id: string;
  slot_id: string;
  status: string;
  payment_status: string | null;
  paid_externally: boolean | null;
  notes: string | null;
  created_at: string;
  availability_slots: RawSlot | null;
}

/**
 * Fetch a player's bookings with resolved trainer display names and the
 * invoice-paid payment-status override applied. Returns newest-first.
 */
export async function fetchPlayerBookings(playerId: string): Promise<PlayerBooking[]> {
  const { data, error } = await supabase
    .from('bookings')
    .select(`
      id,
      slot_id,
      status,
      payment_status,
      paid_externally,
      notes,
      created_at,
      availability_slots(
        start_time,
        end_time,
        trainer_id,
        price_per_session,
        cyclus_name,
        location_id,
        locations(name)
      )
    `)
    .eq('player_id', playerId)
    .order('created_at', { ascending: false });

  if (error) throw error;

  const rawBookings = (data ?? []) as unknown as RawBookingRow[];
  if (rawBookings.length === 0) return [];

  // Resolve trainer display names (business_name → profiles_public → profiles fallback).
  const trainerIds = rawBookings
    .map((b) => b.availability_slots?.trainer_id)
    .filter((id): id is string => !!id);
  const trainerNameMap = await fetchTrainerDisplayNamesByProfileIds(
    trainerIds,
    supabase,
    'playerBookings',
  );

  // Cross-reference paid invoices to get accurate payment status for bookings.
  const { data: paidInvoices } = await supabase
    .from('invoices')
    .select('booking_ids, status, paid_at')
    .eq('player_id', playerId)
    .eq('status', 'paid');

  const paidBookingIds = new Set<string>();
  paidInvoices?.forEach((inv) => {
    (inv.booking_ids as string[] | null)?.forEach((id) => paidBookingIds.add(id));
  });

  return rawBookings.map((booking) => {
    const slot = booking.availability_slots;
    const trainerId = slot?.trainer_id ?? null;
    // If an invoice is paid but the booking still reads pending, override it.
    const effectivePaymentStatus =
      paidBookingIds.has(booking.id) && booking.payment_status !== 'paid'
        ? 'paid'
        : booking.payment_status;
    return {
      id: booking.id,
      slot_id: booking.slot_id,
      status:
        effectivePaymentStatus === 'paid' && booking.status === 'pending'
          ? 'confirmed'
          : booking.status,
      payment_status: effectivePaymentStatus,
      paid_externally: booking.paid_externally,
      notes: booking.notes,
      created_at: booking.created_at,
      start_time: slot?.start_time ?? null,
      end_time: slot?.end_time ?? null,
      trainer_id: trainerId,
      trainer_name: (trainerId && trainerNameMap.get(trainerId)) || 'Trainer',
      location_name: slot?.locations?.name ?? null,
      cyclus_name: slot?.cyclus_name ?? null,
      price_per_session: slot?.price_per_session ?? null,
    };
  });
}
