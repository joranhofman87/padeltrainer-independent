// Phase 3.5c: person-level has_login per booking, for the staff Guest/Registered
// badges + gates. Doctrine (3.3a/3.3d/3.3e): every guest/registered label keys on
// the PERSON's login (persons.user_id), never the seat — under FAM-02 a merged
// login-holder's seats are guest-keyed, so seat-based badges mislabel exactly the
// people the unification merged.
//
// Congruent degradation: when the RPC isn't deployed (or errors), the map is
// empty and callers fall back to their existing seat-based value.
import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';

/** booking_id → the person on that booking has a login account. */
export async function fetchBookingLoginFlags(bookingIds: string[]): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>();
  const ids = [...new Set(bookingIds)].filter(Boolean);
  if (ids.length === 0) return map;
  const { data, error } = await supabase.rpc('get_booking_login_flags', { _booking_ids: ids });
  if (error) {
    logger.warn('get_booking_login_flags unavailable, badges fall back to seat type', {
      component: 'bookingLoginFlags',
      message: error.message,
    });
    return map;
  }
  for (const row of data ?? []) map.set(row.booking_id, row.has_login);
  return map;
}

/**
 * The badge decision for one booking: person-level when known, seat-based
 * fallback otherwise. `seatIsGuest` is the caller's existing `!!guest_player_id`.
 */
export function isGuestForBadge(
  flags: Map<string, boolean>,
  bookingId: string | null | undefined,
  seatIsGuest: boolean,
): boolean {
  if (!bookingId) return seatIsGuest;
  const hasLogin = flags.get(bookingId);
  return hasLogin === undefined ? seatIsGuest : !hasLogin;
}
