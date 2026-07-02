/**
 * Pure decision for the create-mollie-payment RE-PAY branch (existing bookings
 * already carry a mollie_payment_id).
 *
 * Fail-CLOSED invariant: we may only mint a fresh payment for bookings that
 * already have a prior payment once we have POSITIVELY confirmed the prior
 * payment is no longer payable (paid → refuse; open+drift → cancelled). If the
 * probe of the prior payment failed (network throw / non-2xx) or the drift
 * cancel failed, we must NOT fall through to a fresh salted checkout — that
 * leaves two payable checkouts (double charge) and orphans the first payment
 * from the webhook (the DB keeps only the newest id). Return "retry" instead.
 */
export type RepayAction =
  | { kind: "already_paid" }
  | { kind: "reuse" }
  | { kind: "recreate" }
  | { kind: "retry" };

export type RepayProbeOutcome = {
  /** false when the probe fetch threw or returned a non-2xx status. */
  probeOk: boolean;
  /** Mollie payment status when probeOk; ignored otherwise. */
  priorStatus?: string;
  /** Prior payment amount in euros (Number(prior.amount.value)); may be NaN. */
  priorValueEuros?: number;
  /** Amount we are about to charge, in euros. */
  expectedAmount: number;
  /**
   * true when priorStatus === "open" with drifted amount and the stale-payment
   * cancel (DELETE) FAILED. Only meaningful when probeOk.
   */
  cancelFailed?: boolean;
};

export function decideRepayAction(o: RepayProbeOutcome): RepayAction {
  // Probe never confirmed the prior payment's state — do not risk a 2nd checkout.
  if (!o.probeOk) return { kind: "retry" };

  if (o.priorStatus === "paid") return { kind: "already_paid" };

  if (o.priorStatus === "open") {
    const v = Number(o.priorValueEuros);
    if (Number.isFinite(v) && Math.abs(v - o.expectedAmount) <= 0.01) {
      return { kind: "reuse" };
    }
    // Amount drifted: fresh checkout is only safe if the stale one was cancelled.
    if (o.cancelFailed) return { kind: "retry" };
    return { kind: "recreate" };
  }

  // Non-open, non-paid (expired / canceled / failed) — the prior is dead, mint fresh.
  return { kind: "recreate" };
}
