// Per-series cohort canonicalization for bulk-rebook-cycle.
//
// A booking can carry BOTH player_id and guest_player_id (a guest linked to a profile — the
// slot_priority_claims CHECK is `player_id IS NOT NULL OR guest_player_id IS NOT NULL`, NOT xor).
// Keying a cohort naively on `player_id ?? g:guest` then lets the SAME person appear as two entries
// — a registered {player,guest} booking AND a pure {null,guest} booking of the same guest — and the
// claim insert would emit two rows sharing that guest_player_id, violating the partial unique index
// uq_slot_priority_claims_slot_guest (slot_id, guest_player_id) → 23505, aborting the whole run.
//
// canonicalizeSeriesCohort collapses a series' bookings to ONE identity per person: it resolves a
// guest to its linked player when any booking links them, and returns XOR identities (player XOR
// guest) so each generated claim occupies exactly one of the two partial unique indexes and one
// person maps to one claim + one invite.

export interface CohortBooking {
  player_id: string | null;
  guest_player_id: string | null;
}

export function canonicalizeSeriesCohort(bookings: CohortBooking[]): CohortBooking[] {
  // 1. Learn every guest→player link the series' bookings expose (a booking carrying both IDs).
  const guestToPlayer = new Map<string, string>();
  for (const b of bookings) {
    if (b.player_id && b.guest_player_id) guestToPlayer.set(b.guest_player_id, b.player_id);
  }
  // 2. Reduce to one canonical XOR identity per person, keyed by the winning id.
  const cohort = new Map<string, CohortBooking>();
  for (const b of bookings) {
    if (!b.player_id && !b.guest_player_id) continue; // no identity at all — skip
    const playerId = b.player_id ?? (b.guest_player_id ? guestToPlayer.get(b.guest_player_id) ?? null : null);
    const identity: CohortBooking = playerId
      ? { player_id: playerId, guest_player_id: null }
      : { player_id: null, guest_player_id: b.guest_player_id };
    cohort.set(playerId ?? `g:${identity.guest_player_id}`, identity);
  }
  return [...cohort.values()];
}
