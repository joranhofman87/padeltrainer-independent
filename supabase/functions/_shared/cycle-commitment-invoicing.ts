/**
 * Phase 2 — deferred, headcount-split invoicing for rebooked cycles.
 *
 * Model (agreed): when a member rebooks ("Yes"), they COMMIT to the next cycle
 * without paying upfront — the commitment is a confirmed, unpaid booking. When
 * the cycle starts, we count the players who actually committed (N) and invoice
 * each one `cycle_total / N`, where cycle_total = sum of per-session prices.
 *
 * N is the CYCLE-START headcount and must be stable across cron runs: the
 * caller snapshots commitments accepted before the cycle started, and the
 * group headcount here keeps counting committers who already paid (a player
 * paying between runs must not shrink the divisor for the rest of the group).
 * Only open (unpaid) commitments produce invoice batches.
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

/** A booking is a live commitment unless it was cancelled (paid or not). */
export function isActiveCommitment(b: CommitmentBooking): boolean {
  const status = b.status ?? "confirmed";
  return status !== "cancelled" && status !== "cancelled_swap";
}

/** A booking is an open commitment if it's active and not yet paid. */
export function isOpenCommitment(b: CommitmentBooking): boolean {
  return isActiveCommitment(b) && b.payment_status !== "paid";
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
  /** Total distinct active committers across the cycle (for reporting only). */
  committerCount: number;
  /** One invoice batch per committer with open (unpaid) commitments. */
  batches: CommitmentInvoiceBatch[];
};

/**
 * Group open commitment bookings into one invoice batch per committer, with the
 * split headcount scoped to the committer's GROUP (the distinct players sharing
 * their slots). Cancelled bookings and rows without a player key are ignored.
 * Paid commitments produce no batch but STILL count toward the group headcount,
 * so the divisor stays the cycle-start N across runs (M-19): a committer paying
 * between runs must not raise the share billed to the rest of the group.
 */
export function buildCommitmentInvoicePlan(
  bookings: CommitmentBooking[],
): CommitmentInvoicePlan {
  const active = bookings.filter(isActiveCommitment).filter((b) => committerKey(b) !== null);
  const open = active.filter(isOpenCommitment);

  // slot -> set of committer keys on that slot (the group sharing that session).
  // Built from ALL active commitments (paid included) — see headcount note above.
  const slotCommitters = new Map<string, Set<string>>();
  const activeCommitters = new Set<string>();
  for (const b of active) {
    const key = committerKey(b)!;
    const set = slotCommitters.get(b.slot_id) ?? new Set<string>();
    set.add(key);
    slotCommitters.set(b.slot_id, set);
    activeCommitters.add(key);
  }

  // committer -> their open booking ids + the slots they're in.
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

  return { committerCount: activeCommitters.size, batches };
}
