// FAM-02 Level 1 identity resolution for EDGE functions — the keep-in-sync twin of
// src/lib/personIdentity.ts (which explicitly calls for this file "the day an edge feature
// needs it"). Same rule, same key format, so an edge surface and a frontend/SQL surface can
// never disagree about who a dual-keyed row belongs to.
//
// THE RULE: guest_players and profiles are DISTINCT people. A row carrying BOTH player_id and
// guest_player_id belongs to the GUEST person — the player_id beside it is legacy link
// decoration (the historical signup linker adds player_id onto guest rows), NOT an identity.
// So EVERYTHING keys, groups, addresses and displays GUEST-FIRST off the IDs — never off which
// joined name happens to be non-blank (the mistake in the first pass at this).

export interface PersonIdRow {
  player_id?: string | null;
  guest_player_id?: string | null;
}

export type PersonRef =
  | { playerId: string; guestPlayerId: null }
  | { playerId: null; guestPlayerId: string };

/** Stable namespaced person key — `g:<guest>` (guest wins on dual rows) else `p:<player>`. */
export function personKeyOf(row: PersonIdRow): string | null {
  if (row.guest_player_id) return `g:${row.guest_player_id}`;
  if (row.player_id) return `p:${row.player_id}`;
  return null;
}

/** XOR person ref — guest wins on dual-keyed rows. Null when no identity. */
export function personRefOf(row: PersonIdRow): PersonRef | null {
  if (row.guest_player_id) return { playerId: null, guestPlayerId: row.guest_player_id };
  if (row.player_id) return { playerId: row.player_id, guestPlayerId: null };
  return null;
}

/**
 * Display name under Level 1: a guest person shows their OWN name (the profile name is used
 * ONLY as a blank-name fallback for a guest); a profile person shows the profile name. Keyed on
 * the IDs, NOT on which name is non-blank — so a dual-key child with a name shows the child, and
 * the linked parent's name appears only when the guest genuinely has no name on file.
 */
export function personDisplayName(
  row: PersonIdRow,
  names: { profileName?: string | null; guestName?: string | null },
  fallback = "Speler",
): string {
  const profile = names.profileName?.trim() || null;
  const guest = names.guestName?.trim() || null;
  const chosen = row.guest_player_id ? (guest ?? profile) : profile;
  return chosen ?? fallback;
}

/**
 * Contact email under Level 1, guest-first: a guest person is reached at THEIR OWN email; the
 * linked profile's address is a fallback ONLY when the guest has no email of their own (e.g. a
 * child under a parent's account). A profile person is reached at the profile email.
 */
export function personContactEmail(
  row: PersonIdRow,
  emails: { profileEmail?: string | null; guestEmail?: string | null },
): string | null {
  const profile = emails.profileEmail?.trim() || null;
  const guest = emails.guestEmail?.trim() || null;
  return row.guest_player_id ? (guest ?? profile) : profile;
}
