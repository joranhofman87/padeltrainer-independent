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

/** A page of past bookings plus whether more remain (for "load older" pagination). */
export interface PlayerBookingsPage {
  bookings: PlayerBooking[];
  hasMore: boolean;
}

const slotSelect = (join: '' | '!inner') => `
  id,
  slot_id,
  status,
  payment_status,
  paid_externally,
  notes,
  created_at,
  availability_slots${join}(
    start_time,
    end_time,
    trainer_id,
    price_per_session,
    cyclus_name,
    location_id,
    locations(name)
  )
`;

/**
 * Resolve trainer display names + apply the invoice-paid payment-status override to a set of raw
 * booking rows. Shared by every fetch below so they never diverge on status/payment.
 */
async function enrichBookings(rawBookings: RawBookingRow[], playerId: string): Promise<PlayerBooking[]> {
  if (rawBookings.length === 0) return [];

  // Resolve trainer display names (business_name → profiles_public → profiles fallback).
  const trainerIds = rawBookings
    .map((b) => b.availability_slots?.trainer_id)
    .filter((id): id is string => !!id);
  const trainerNameMap = await fetchTrainerDisplayNamesByProfileIds(trainerIds, supabase, 'playerBookings');

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

/**
 * Fetch ALL of a player's bookings, newest-first. Used by the dashboard (which shows only a small
 * upcoming slice). The bookings page uses the paginated pair below instead, to avoid loading a
 * long-tenured player's entire history at once.
 */
export async function fetchPlayerBookings(playerId: string): Promise<PlayerBooking[]> {
  const { data, error } = await supabase
    .from('bookings')
    .select(slotSelect(''))
    .eq('player_id', playerId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return enrichBookings((data ?? []) as unknown as RawBookingRow[], playerId);
}

/**
 * Fetch the player's UPCOMING bookings in full (future slot, not cancelled). `!inner` filters to
 * bookings whose (visible) slot starts in the future — naturally bounded, so it is never paginated.
 * A booking into a since-made-private slot has no visible slot row → excluded here → it falls into
 * the past page instead, exactly as the old single-fetch split classified it.
 */
export async function fetchUpcomingPlayerBookings(playerId: string): Promise<PlayerBooking[]> {
  const nowISO = new Date().toISOString();
  const { data, error } = await supabase
    .from('bookings')
    .select(slotSelect('!inner'))
    .eq('player_id', playerId)
    .neq('status', 'cancelled')
    .gte('availability_slots.start_time', nowISO)
    .order('start_time', { ascending: true, referencedTable: 'availability_slots' });

  if (error) throw error;
  return enrichBookings((data ?? []) as unknown as RawBookingRow[], playerId);
}

/**
 * Fetch one page of the player's PAST bookings (newest-created first) for "load older" pagination of
 * the Past tab. The complete upcoming set is fetched separately; passing its ids as `excludeIds`
 * removes them at the DB so each page is pure past (cancelled / past-slot / made-private) — clean
 * pagination with no wasted rows. `past = everything not upcoming`, exactly the old single-fetch split.
 *
 * Offset pagination (not keyset): a booking inserted/deleted between "load older" clicks could shift
 * the window and skip/dupe one past row. Benign here — the player can't create bookings from this
 * page, and any cancel triggers a full refetch that resets pagination — so the window never drifts
 * in practice. A single page load is always an exact partition.
 */
export async function fetchPlayerBookingsPage(
  playerId: string,
  limit: number,
  offset: number,
  excludeIds: string[] = [],
): Promise<PlayerBookingsPage> {
  let query = supabase
    .from('bookings')
    .select(slotSelect(''))
    .eq('player_id', playerId);
  if (excludeIds.length > 0) {
    query = query.not('id', 'in', `(${excludeIds.join(',')})`);
  }
  const { data, error } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  const raw = (data ?? []) as unknown as RawBookingRow[];
  return { bookings: await enrichBookings(raw, playerId), hasMore: raw.length === limit };
}
