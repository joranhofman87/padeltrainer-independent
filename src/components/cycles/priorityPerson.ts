/**
 * An academy player the academy grants rebook priority to. Either a REGISTERED player granted via
 * their in-scope profile (id = profiles.id) or a person granted via their guest ref
 * (id = guest_players.id) — usually accountless, but since Phase 3.3e also possibly a login holder
 * whose profile is outside this academy's scope. Accountless guests are reached exactly like guest
 * cohort members: emailed a pre-filled "create account & book" link (their guest row links by email
 * at signup, clause e); a guest ref whose PERSON already has a login is granted the member window
 * directly by can_book_member_window's person arms (clauses d/e) — see toPriorityPerson below.
 * Kept in a plain module (not the component file) so the pure mapper can be shared + unit-tested
 * without tripping the react-refresh component-export rule.
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
  // A registered player with an IN-SCOPE profile → grant via the profile id (rebook_priority_people).
  if (row.player_type === 'registered' && row.profile_id) {
    return { id: row.profile_id, player_type: 'registered', full_name: row.full_name, email: row.email ?? null };
  }
  // Otherwise, anyone reachable via their guest ref → grant via the guest id (rebook_priority_guests;
  // can_book_member_window clause (e) resolves the guest→person, Phase 3.3c). This covers a plain
  // guest AND — since Phase 3.3e made player_type person-level — a login holder whose profile is out
  // of THIS academy's scope (player_type='registered' but profile_id null, a guest ref remaining);
  // without this they'd silently drop out of the priority picker. A null/unknown player_type is still
  // dropped (defensive — the real overview only ever returns 'registered' or 'guest').
  if ((row.player_type === 'guest' || row.player_type === 'registered') && row.guest_player_id) {
    return { id: row.guest_player_id, player_type: 'guest', full_name: row.full_name, email: row.email ?? null };
  }
  return null;
}
