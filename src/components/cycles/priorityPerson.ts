/**
 * An academy player the academy grants rebook priority to. Either a REGISTERED player
 * (id = profiles.id) or a GUEST academy player with no login (id = guest_players.id). Guests are
 * reached exactly like guest cohort members: emailed a pre-filled "create account & book" link;
 * once they sign up their guest row links by email and can_book_member_window grants them the
 * member window (clause e). Kept in a plain module (not the component file) so the pure mapper can
 * be shared + unit-tested without tripping the react-refresh component-export rule.
 */
export interface PriorityPerson {
  id: string; // profiles.id (registered) OR guest_players.id (guest)
  player_type: 'registered' | 'guest';
  full_name: string;
  email: string | null;
}

/** Row shape from fetchAllPlayersOverview that we need to build a PriorityPerson. */
export interface OverviewRowLike {
  player_type: string | null;
  profile_id: string | null;
  guest_player_id: string | null;
  full_name: string;
  email: string | null;
}

/** Map an academy-players-overview row to a PriorityPerson, or null if it can't be granted priority. */
export function toPriorityPerson(row: OverviewRowLike): PriorityPerson | null {
  if (row.player_type === 'registered' && row.profile_id) {
    return { id: row.profile_id, player_type: 'registered', full_name: row.full_name, email: row.email ?? null };
  }
  if (row.player_type === 'guest' && row.guest_player_id) {
    return { id: row.guest_player_id, player_type: 'guest', full_name: row.full_name, email: row.email ?? null };
  }
  return null;
}
