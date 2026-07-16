// FAM-02 Level 1 identity resolution — THE person rule for dual-keyed rows.
//
// guest_players and profiles are DISTINCT people (owner ruling, architecture audit 2026-07-11
// §4.3): guest_players.linked_profile_id is deprecated/inert, and a row carrying BOTH
// player_id and guest_player_id (bookings/claims/invoices/intakes written by the historical
// signup linker, which ADDS player_id onto guest rows) belongs to the GUEST person — the
// player_id beside it is legacy link decoration, not an identity. Same-person duplicates are
// reconciled only via merge_guest_players, never via the link.
//
// This module is the single TS home of that rule (person key, XOR ref, booking match scope,
// display name). SQL surfaces encode the same rule inline (e.g. get_academy_cyclus_groups
// person keys 'g:<id>'/'p:<id>'; get_players_overview 'g_'/'p_'). There is deliberately no
// edge-function twin yet — create supabase/functions/_shared/person-identity.ts as a
// keep-in-sync twin (profileName.ts pattern) the day an edge feature needs it.

/** Any row shape that can carry the two identity columns (booking, claim, invoice, intake). */
export interface PersonIdRow {
  player_id?: string | null;
  guest_player_id?: string | null;
  /** Phase 1+ dual-write stamp: the row's person in the unified world (persons.id). */
  person_id?: string | null;
}

/** A resolved person: exactly ONE of the two ids — guest wins on dual-keyed rows. */
export type PersonRef =
  | { playerId: string; guestPlayerId: null }
  | { playerId: null; guestPlayerId: string };

/**
 * Stable person key for dedup/grouping: `g:<guest_player_id>` (guest wins on dual rows),
 * else `p:<player_id>`, else null. Namespaced so a guest and a profile can never collide.
 */
export function personKeyOf(row: PersonIdRow): string | null {
  if (row.guest_player_id) return `g:${row.guest_player_id}`;
  if (row.player_id) return `p:${row.player_id}`;
  return null;
}

/**
 * Phase 3.1 unified person key — person_id-FIRST, raw-uuid fallback for unstamped rows.
 *
 * The fallback is CONGRUENT with the stamp by construction: person ids are deterministic (= the
 * source row's uuid — the profile id for account holders and merged twins, the guest id for
 * guest-only persons) and the dual-write triggers derive guest-side-first, exactly like the
 * fallback below. So a stamped row and an unstamped row of the SAME person produce the SAME key,
 * and a merged twin's unstamped guest row degrades to today's split view — never worse than the
 * old keying, usually strictly better (one human = one key across both old columns).
 */
export function unifiedPersonKeyOf(row: PersonIdRow): string | null {
  const id = row.person_id ?? row.guest_player_id ?? row.player_id ?? null;
  return id ? `person:${id}` : null;
}

/** Resolve a row to its XOR person ref — guest wins on dual-keyed rows. Null when no identity. */
export function personRefOf(row: PersonIdRow): PersonRef | null {
  if (row.guest_player_id) return { playerId: null, guestPlayerId: row.guest_player_id };
  if (row.player_id) return { playerId: row.player_id, guestPlayerId: null };
  return null;
}

/** camelCase convenience for callers holding roster-entry style `{playerId, guestPlayerId}`. */
export function personRefOfIds(
  playerId?: string | null,
  guestPlayerId?: string | null,
): PersonRef | null {
  return personRefOf({ player_id: playerId ?? null, guest_player_id: guestPlayerId ?? null });
}

/**
 * Scope a bookings (or claims) query to ALL rows belonging to one person:
 * - guest person   → every row carrying their guest_player_id (dual-keyed rows are theirs);
 * - profile person → rows keyed player_id WITH guest_player_id NULL (dual-keyed rows are NOT
 *   theirs — they belong to the guest). This is what stops a whole-cycle Remove of the
 *   profile-holder from also cancelling a linked guest's seats, and vice versa.
 *
 * `Q` is deliberately unconstrained: a structural constraint over supabase-js's recursive
 * PostgrestFilterBuilder generics trips TS2589 (excessively deep instantiation) on typed
 * clients. The eq/is call shape is pinned by unit tests instead.
 */
export function matchBookingsToPerson<Q>(query: Q, ref: PersonRef): Q {
  const q = query as unknown as {
    eq(column: string, value: string): unknown;
    is(column: string, value: null): unknown;
  };
  const scoped = ref.guestPlayerId
    ? q.eq('guest_player_id', ref.guestPlayerId)
    : (q.eq('player_id', ref.playerId) as typeof q).is('guest_player_id', null);
  return scoped as Q;
}

/**
 * Display name under Level 1: a guest person shows their OWN name (profile name only as a
 * blank-name fallback — mirrors coalesceLinkedGuestIdentity's guest-first identity rule);
 * a profile person shows the profile name. Returns null when nothing usable is on file.
 */
export function personDisplayName(
  row: PersonIdRow,
  names: { profileName?: string | null; guestName?: string | null },
): string | null {
  const profile = names.profileName?.trim() || null;
  const guest = names.guestName?.trim() || null;
  return row.guest_player_id ? guest ?? profile : profile;
}
