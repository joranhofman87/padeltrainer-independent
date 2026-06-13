/**
 * Single source of truth for "what is the name of the player on this booking".
 *
 * A booking's participant is either a registered profile (player_id) or a guest
 * (guest_player_id). Surfaces that select only the profile join render guests as
 * a generic "Player"; this resolver + the matching join shape make a guest show
 * by name everywhere (trainer earnings, cyclus rosters, academy slot detail).
 *
 * Accepts either the explicit `player:` alias or the implicit `profiles` embed,
 * plus the `guest_players` embed.
 */
export interface BookedPlayerNameSource {
  player?: { full_name?: string | null } | null;
  profiles?: { full_name?: string | null } | null;
  guest_players?: { full_name?: string | null } | null;
}

export function getBookedPlayerName(
  booking: BookedPlayerNameSource,
  placeholder = 'Player',
): string {
  return (
    booking.player?.full_name?.trim() ||
    booking.profiles?.full_name?.trim() ||
    booking.guest_players?.full_name?.trim() ||
    placeholder
  );
}
