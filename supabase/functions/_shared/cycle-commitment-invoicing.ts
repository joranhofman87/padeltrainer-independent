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
};

export type CommitmentInvoicePlan = {
  /** Distinct committers — the N to split the cycle total by. */
  committerCount: number;
  /** One invoice batch per committer (their booking ids in this cycle). */
  batches: CommitmentInvoiceBatch[];
};

/**
 * Group open commitment bookings by player into one invoice batch each, and
 * report the headcount used for the split. Paid/cancelled bookings and rows
 * without any player key are ignored.
 */
export function buildCommitmentInvoicePlan(
  bookings: CommitmentBooking[],
): CommitmentInvoicePlan {
  const byPlayer = new Map<string, string[]>();
  for (const b of bookings) {
    if (!isOpenCommitment(b)) continue;
    const key = committerKey(b);
    if (!key) continue;
    const list = byPlayer.get(key) ?? [];
    list.push(b.id);
    byPlayer.set(key, list);
  }
  const batches: CommitmentInvoiceBatch[] = Array.from(byPlayer.entries()).map(
    ([playerKey, bookingIds]) => ({ playerKey, bookingIds }),
  );
  return { committerCount: batches.length, batches };
}
