// The recipient a duplicate-invoice lookup must scope to, matching
// create_invoice_deduped's GUEST-FIRST recipient rule (FAM-02: a row carrying a
// guest_player_id belongs to the GUEST person — even when a player_id is also set).
//
// This is the single source of truth for auto-create-invoice's 23505 race-fallback.
// It must NOT be recipient-agnostic: the legacy uniq_invoice_active_player_bookings
// index has predicate `player_id IS NOT NULL`, so it covers dual-key rows — a dual-key
// create for the exact booking set of a pure-profile invoice raises 23505 after the RPC
// correctly refuses to dedup cross-recipient. A recipient-agnostic (or player-first)
// winner lookup would then return + sync-to-paid that guest-owned booking onto the
// profile invoice the RPC rejected. Scoping guest-first means the cross-recipient
// collision yields NO winner and the caller surfaces the data inconsistency instead.

export type DedupRecipient =
  | { kind: "guest"; guestPlayerId: string }
  | { kind: "profile"; playerId: string }
  | null;

/** Resolve the guest-first dedup recipient from a (playerId, guestPlayerId) pair. */
export function dedupRecipientMatch(
  playerId: string | null | undefined,
  guestPlayerId: string | null | undefined,
): DedupRecipient {
  if (guestPlayerId) return { kind: "guest", guestPlayerId };
  if (playerId) return { kind: "profile", playerId };
  return null;
}

/** Minimal shape of the supabase-js query builder this helper needs (also lets tests fake it). */
export interface RecipientScopableQuery {
  eq(column: string, value: string): RecipientScopableQuery;
  is(column: string, value: null): RecipientScopableQuery;
}

/**
 * Apply the guest-first recipient scope to a duplicate-lookup query. A guest recipient
 * scopes to guest_player_id; a pure-profile recipient scopes to player_id AND
 * guest_player_id IS NULL (== create_invoice_deduped's arm A). Returns the query
 * unchanged when there is no recipient (the caller then finds no winner).
 */
export function applyDedupRecipientScope(
  query: RecipientScopableQuery,
  playerId: string | null | undefined,
  guestPlayerId: string | null | undefined,
): void {
  const r = dedupRecipientMatch(playerId, guestPlayerId);
  if (r?.kind === "guest") {
    query.eq("guest_player_id", r.guestPlayerId);
  } else if (r?.kind === "profile") {
    query.eq("player_id", r.playerId).is("guest_player_id", null);
  }
}
