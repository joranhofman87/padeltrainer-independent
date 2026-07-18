import { supabase } from '@/lib/supabaseClient';
import { fetchTrainerDisplayNamesByProfileIds } from '@/lib/trainerDisplayNames';
import { logger } from '@/lib/logger';

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
  /**
   * True for sessions surfaced via a LINKED GUEST record (booked on the player's behalf, keyed by
   * guest_player_id, player_id NULL). The player can SEE these but cannot UPDATE them — the player
   * bookings UPDATE policy is player_id-scoped — so the UI must not offer a (RLS-doomed) Cancel.
   */
  is_linked_guest: boolean;
}

interface RawSlot {
  start_time: string | null;
  end_time: string | null;
  trainer_id: string | null;
  price_per_session: number | null;
  cyclus_name: string | null;
  /** Present on linked-guest RPC rows (unused by enrich; consumed by PlayerAgenda). */
  location_id?: string | null;
  max_participants?: number | null;
  locations: { name: string } | null;
}

export interface RawBookingRow {
  id: string;
  slot_id: string;
  status: string;
  payment_status: string | null;
  paid_externally: boolean | null;
  notes: string | null;
  created_at: string;
  availability_slots: RawSlot | null;
  /** Set on rows from the linked-guest RPC (player_id IS NULL); absent on player_id rows. */
  is_linked_guest?: boolean;
}

/**
 * Linked-guest VISIBILITY (rebook go-live B2). A session booked on behalf of the player under a
 * guest record LINKED to their profile (academy add / group-captain rebook) is keyed by
 * guest_player_id, so the player_id reads below can't return it and RLS hides it. This best-effort
 * helper pulls those rows via the SECURITY DEFINER RPC (scoped to the caller's linked guests) so
 * callers can MERGE them into the player_id results. Returns [] on any error — these rows are
 * supplementary, so a missing/failed RPC (e.g. migration not yet applied → PGRST202) must never
 * blank the player's own bookings.
 */
export async function fetchLinkedGuestBookingRows(): Promise<RawBookingRow[]> {
  try {
    const { data, error } = await supabase.rpc('get_my_linked_guest_bookings');
    if (error) {
      if (error.code !== 'PGRST202') {
        logger.warn('get_my_linked_guest_bookings failed; showing player_id bookings only', {
          component: 'playerBookings',
          code: error.code,
        });
      }
      return [];
    }
    // Tag every row so downstream UI can tell a linked-guest session (read-only for the player)
    // from a player_id session (cancellable).
    return ((data ?? []) as unknown as RawBookingRow[]).map((r) => ({ ...r, is_linked_guest: true }));
  } catch (e) {
    logger.warn('get_my_linked_guest_bookings threw; showing player_id bookings only', {
      component: 'playerBookings',
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}

/** Is this linked-guest row upcoming: not cancelled, with a slot starting at/after `nowISO`? */
function isUpcomingGuestRow(r: RawBookingRow, nowMs: number): boolean {
  const start = r.availability_slots?.start_time;
  // Compare as epochs, not strings — the RPC's jsonb timestamp (+00:00) and Date.toISOString()
  // (.000Z) use different textual forms for the same instant.
  return r.status !== 'cancelled' && !!start && new Date(start).getTime() >= nowMs;
}

/** Linked-guest rows that belong in the UPCOMING set: not cancelled, with a future slot. */
export function selectFutureActiveGuestRows(rows: RawBookingRow[], nowISO: string): RawBookingRow[] {
  const nowMs = new Date(nowISO).getTime();
  return rows.filter((r) => isUpcomingGuestRow(r, nowMs));
}

/**
 * Linked-guest rows that belong in the PAST set: everything NOT upcoming (cancelled, no visible
 * slot, or a past slot), minus any already shown via the upcoming set (excludeIds).
 */
export function selectPastGuestRows(
  rows: RawBookingRow[],
  nowISO: string,
  excludeIds: string[],
): RawBookingRow[] {
  const exclude = new Set(excludeIds);
  const nowMs = new Date(nowISO).getTime();
  return rows.filter((r) => !exclude.has(r.id) && !isUpcomingGuestRow(r, nowMs));
}

const byCreatedAtDesc = (a: PlayerBooking, b: PlayerBooking) => b.created_at.localeCompare(a.created_at);
const byStartTimeAsc = (a: PlayerBooking, b: PlayerBooking) =>
  (a.start_time ?? '').localeCompare(b.start_time ?? '');

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

  // Cross-reference PAID invoices to get accurate payment status. Guest-aware (rebook go-live B2):
  // the RPC covers invoices keyed by player_id OR a guest linked to this profile, so a linked-guest
  // booking covered by a paid invoice reads "paid" too. Falls back to the legacy player_id-only
  // read when the RPC isn't deployed yet (PGRST202).
  const paidBookingIds = new Set<string>();
  const paidRpc = await supabase.rpc('get_my_paid_booking_ids');
  if (paidRpc.error) {
    // Any RPC error (not-deployed PGRST202 or transient) degrades to the legacy player_id-only
    // invoices read — same best-effort behaviour as before (a failed paid lookup never errors the
    // page; the booking's own payment_status simply stands, and linked-guest paid status is lost).
    // Phase 3.5a note: the player SELECT policy is now PURE-PROFILE, so this fallback also no
    // longer sees BOTH-keyed paid invoices (linker-stamped rows) — acceptable: it only runs in a
    // double-failure window and the RPC (the happy path) covers every arm.
    const { data: paidInvoices } = await supabase
      .from('invoices')
      .select('booking_ids, status, paid_at')
      .eq('player_id', playerId)
      .eq('status', 'paid');
    paidInvoices?.forEach((inv) => {
      (inv.booking_ids as string[] | null)?.forEach((id) => paidBookingIds.add(id));
    });
  } else {
    ((paidRpc.data ?? []) as { booking_id: string }[]).forEach((r) => paidBookingIds.add(r.booking_id));
  }

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
      is_linked_guest: booking.is_linked_guest ?? false,
    };
  });
}

/**
 * Fetch ALL of a player's bookings, newest-first. Used by the dashboard (which shows only a small
 * upcoming slice). The bookings page uses the paginated pair below instead, to avoid loading a
 * long-tenured player's entire history at once.
 */
export async function fetchPlayerBookings(playerId: string): Promise<PlayerBooking[]> {
  const [{ data, error }, guestRows] = await Promise.all([
    supabase
      .from('bookings')
      .select(slotSelect(''))
      .eq('player_id', playerId)
      .is('guest_player_id', null) // FAM-02: dual-keyed rows are the GUEST person's — they arrive via the frozen RPC
      .order('created_at', { ascending: false }),
    fetchLinkedGuestBookingRows(),
  ]);

  if (error) throw error;
  const raw = [...((data ?? []) as unknown as RawBookingRow[]), ...guestRows];
  return (await enrichBookings(raw, playerId)).sort(byCreatedAtDesc);
}

/**
 * Fetch the player's UPCOMING bookings in full (future slot, not cancelled). `!inner` filters to
 * bookings whose (visible) slot starts in the future — naturally bounded, so it is never paginated.
 * A booking into a since-made-private slot has no visible slot row → excluded here → it falls into
 * the past page instead, exactly as the old single-fetch split classified it.
 */
export async function fetchUpcomingPlayerBookings(playerId: string): Promise<PlayerBooking[]> {
  const nowISO = new Date().toISOString();
  const [{ data, error }, guestRows] = await Promise.all([
    supabase
      .from('bookings')
      .select(slotSelect('!inner'))
      .eq('player_id', playerId)
      .is('guest_player_id', null) // FAM-02: dual-keyed rows are the GUEST person's — they arrive via the frozen RPC
      .neq('status', 'cancelled')
      .gte('availability_slots.start_time', nowISO)
      .order('start_time', { ascending: true, referencedTable: 'availability_slots' }),
    fetchLinkedGuestBookingRows(),
  ]);

  if (error) throw error;
  const raw = [
    ...((data ?? []) as unknown as RawBookingRow[]),
    ...selectFutureActiveGuestRows(guestRows, nowISO),
  ];
  return (await enrichBookings(raw, playerId)).sort(byStartTimeAsc);
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
    .eq('player_id', playerId)
    .is('guest_player_id', null); // FAM-02: dual-keyed rows are the GUEST person's — they arrive via the frozen RPC
  if (excludeIds.length > 0) {
    query = query.not('id', 'in', `(${excludeIds.join(',')})`);
  }
  const { data, error } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  const playerRaw = (data ?? []) as unknown as RawBookingRow[];
  // "More remain" is governed by the player_id page (the linked-guest tail is a one-shot add to
  // page 1), so the existing pagination contract is unchanged.
  const hasMore = playerRaw.length === limit;

  let raw = playerRaw;
  if (offset === 0) {
    // The first past page also carries the player's PAST linked-guest bookings (few; the upcoming
    // ones are surfaced by fetchUpcomingPlayerBookings and passed here as excludeIds).
    const nowISO = new Date().toISOString();
    const pastGuest = selectPastGuestRows(await fetchLinkedGuestBookingRows(), nowISO, excludeIds);
    raw = [...playerRaw, ...pastGuest];
  }
  return { bookings: (await enrichBookings(raw, playerId)).sort(byCreatedAtDesc), hasMore };
}
