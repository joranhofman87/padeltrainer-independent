/**
 * Phase 2 — deferred, headcount-split invoicing for rebooked cycles.
 *
 * Model (agreed): when a member rebooks ("Yes"), they COMMIT to the next cycle
 * without paying upfront — the commitment is a confirmed, unpaid booking. When
 * the cycle starts, we count the players who actually committed (N) and invoice
 * each one `cycle_total / N`, where cycle_total = sum of per-session prices.
 *
 * This module holds the pure selection/grouping decisions so the deferred
 * invoicing job (an edge function run from the daily cron) stays thin and the
 * logic is unit-tested. The actual money split is delegated to the existing
 * applySplitPayment / auto-create-invoice (which accepts splitAmongPlayers).
 */

/** A confirmed, unpaid commitment booking awaiting cycle-start invoicing. */
export type CommitmentBooking = {
  id: string;
  slot_id: string;
  player_id: string | null;
  guest_player_id: string | null;
  payment_status: string | null;
  status: string | null;
};

/** A cycle is due for commitment invoicing once it has started. */
export function isCycleDueForInvoicing(
  startDate: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!startDate) return false;
  const start = new Date(startDate).getTime();
  if (Number.isNaN(start)) return false;
  return start <= now.getTime();
}

/** Stable per-player key (registered player or guest). */
export function committerKey(b: CommitmentBooking): string | null {
  return b.player_id ?? b.guest_player_id ?? null;
}

/** A booking is an open commitment if it's active and not yet paid. */
export function isOpenCommitment(b: CommitmentBooking): boolean {
  const status = b.status ?? "confirmed";
  const paid = b.payment_status === "paid";
  return !paid && status !== "cancelled" && status !== "cancelled_swap";
}

export type CommitmentInvoiceBatch = {
  playerKey: string;
  bookingIds: string[];
  /**
   * Headcount of the player's GROUP — the number to split each session price
   * by. This is per-group (players sharing the same slots), NOT the whole
   * cycle, so a cycle with two independent groups bills each correctly.
   */
  splitAmongPlayers: number;
};

export type CommitmentInvoicePlan = {
  /** Total distinct committers across the cycle (for reporting only). */
  committerCount: number;
  /** One invoice batch per committer. */
  batches: CommitmentInvoiceBatch[];
};

/**
 * Group open commitment bookings into one invoice batch per committer, with the
 * split headcount scoped to the committer's GROUP (the distinct players sharing
 * their slots). Paid/cancelled bookings and rows without a player key are
 * ignored.
 */
export function buildCommitmentInvoicePlan(
  bookings: CommitmentBooking[],
): CommitmentInvoicePlan {
  const open = bookings.filter(isOpenCommitment).filter((b) => committerKey(b) !== null);

  // slot -> set of committer keys on that slot (the group sharing that session).
  const slotCommitters = new Map<string, Set<string>>();
  for (const b of open) {
    const key = committerKey(b)!;
    const set = slotCommitters.get(b.slot_id) ?? new Set<string>();
    set.add(key);
    slotCommitters.set(b.slot_id, set);
  }

  // committer -> their booking ids + the slots they're in.
  const byPlayer = new Map<string, { bookingIds: string[]; slotIds: Set<string> }>();
  for (const b of open) {
    const key = committerKey(b)!;
    const entry = byPlayer.get(key) ?? { bookingIds: [], slotIds: new Set<string>() };
    entry.bookingIds.push(b.id);
    entry.slotIds.add(b.slot_id);
    byPlayer.set(key, entry);
  }

  const batches: CommitmentInvoiceBatch[] = Array.from(byPlayer.entries()).map(
    ([playerKey, { bookingIds, slotIds }]) => {
      // The player's group = everyone sharing any of their slots.
      const group = new Set<string>();
      for (const slotId of slotIds) {
        for (const k of slotCommitters.get(slotId) ?? []) group.add(k);
      }
      return { playerKey, bookingIds, splitAmongPlayers: Math.max(1, group.size) };
    },
  );

  return { committerCount: byPlayer.size, batches };
}
