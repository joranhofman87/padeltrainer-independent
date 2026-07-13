// Per-series cohort canonicalization for bulk-rebook-cycle.
//
// FAM-02 Level 1 (owner ruling, architecture audit 2026-07-11 §4.3): guest_players and
// profiles are DISTINCT people. A booking carrying BOTH ids (the historical signup linker
// ADDS player_id onto guest bookings; the claims CHECK is `player OR guest`, NOT xor) is the
// GUEST person's booking — the player_id beside it is legacy link decoration. The previous
// canonicalizer resolved a linked guest to its player_id, which MERGED a parent and a linked
// child into one claim: the child silently got no invite and no seat in the next round.
//
// canonicalizeSeriesCohort therefore keys people GUEST-FIRST and returns XOR identities:
// one entry per guest_player_id (player_id null) + one per pure player_id (guest null).
// 23505 safety is preserved by construction — the crash vector (the same guest appearing
// both bare {null,G} and linked {P,G} in one series) collapses onto the single key `g:G`,
// so the claim insert emits at most one row per (slot, guest_player_id) and per
// (slot, player_id), and each row lives in exactly one of the two partial unique indexes
// (uq_slot_priority_claims_slot_guest / uq_slot_priority_claims_slot_player).

export interface CohortBooking {
  player_id: string | null;
  guest_player_id: string | null;
}

/** Guest-first person key — shared with bulk-rebook-cycle's preview/headline counts so the
 *  wizard's numbers can never diverge from the claims actually created. */
export const cohortPersonKey = (b: CohortBooking): string | null =>
  b.guest_player_id ? `g:${b.guest_player_id}` : b.player_id;

export function canonicalizeSeriesCohort(bookings: CohortBooking[]): CohortBooking[] {
  const cohort = new Map<string, CohortBooking>();
  for (const b of bookings) {
    if (b.guest_player_id) {
      cohort.set(`g:${b.guest_player_id}`, { player_id: null, guest_player_id: b.guest_player_id });
    } else if (b.player_id) {
      cohort.set(b.player_id, { player_id: b.player_id, guest_player_id: null });
    }
    // no identity at all — skip
  }
  return [...cohort.values()];
}
