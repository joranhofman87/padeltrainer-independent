/**
 * 10c-b D — THE INSTANT SEND GATE, as production-owned, testable logic.
 *
 * notification-email-worker/index.ts ends in `serve(handler)` and can never be imported, so the
 * decision that actually matters — "may this claimed outbox row be delivered right now?" — lived
 * where no test could reach it. Source-text assertions on the handler are not a substitute: they
 * stay green while the ORDER of the checks, their fail-closed behaviour, or their terminal-ness
 * regresses. The decision therefore lives here and the handler just executes the verdict.
 *
 * WHY A GATE AT ALL. Enqueue and send are separated in time. Everything the resolver decided at
 * enqueue can be false by the time the worker claims the row: the contact can be revoked, moved
 * out of tenant consent scope or deleted, the address can CHANGE, a bounce/complaint can land,
 * the v2 cadence can be switched off, or (for open slots) the player can unfollow the trainer.
 * Sending on stale authorisation is the failure mode this gate exists to prevent.
 *
 * FAIL CLOSED IS THE WHOLE POINT. Every check that cannot be evaluated results in a RETRYABLE
 * failure, never a send. A gate that fell open on error would mail exactly the addresses it was
 * built to protect — a suppressed recipient, or someone who just unfollowed.
 */

/** The subset of a claimed outbox row the gate needs. */
export type ClaimedRowForGate = {
  outbox_id: string;
  destination_normalized?: string | null;
  payload?: { subject?: unknown; html?: unknown } | null;
};

/** Injected so the gate is exercised directly; the worker passes real RPC-backed impls. */
export type GateDeps = {
  isEmailSuppressed: (email: string) => Promise<{ data: boolean | null; error: unknown }>;
  memberStopReason: (outboxId: string) => Promise<{ data: string | null; error: unknown }>;
};

export type GateVerdict =
  /** Deliverable now. `dest`/`subject`/`html` are validated non-empty. */
  | { action: "send"; dest: string; subject: string; html: string }
  /**
   * Do not deliver. `terminal` distinguishes "never retry" from "try again next tick";
   * `countAs` mirrors the worker's own tallies so the counters cannot drift from the decision.
   */
  | { action: "stop"; error: string; terminal: boolean; countAs: "failed" | "suppressed" };

/**
 * Evaluate the gate for one claimed row.
 *
 * ORDER IS LOAD-BEARING and asserted by the suite:
 *   1. renderability   — a row with no destination/subject/html can never succeed → TERMINAL,
 *                        and is checked first so we never burn an RPC on a dead row;
 *   2. suppression     — cheap, and the one check that must never be skipped;
 *   3. full live policy — the resolver's own lookup re-run (contact/scope/address/preference/
 *                        event hook). Last because it is the broadest and most expensive.
 */
export async function evaluateInstantSendGate(
  row: ClaimedRowForGate,
  deps: GateDeps,
): Promise<GateVerdict> {
  const dest = (row.destination_normalized ?? "").trim();
  const payload = row.payload ?? {};
  const subject = typeof payload.subject === "string" ? payload.subject : "";
  const html = typeof payload.html === "string" ? payload.html : "";

  // 1. A row that can never render is terminal — never burn retries on it.
  if (!dest || !subject || !html) {
    return {
      action: "stop",
      error: !dest ? "missing_destination" : "missing_subject_or_html",
      terminal: true,
      countAs: "failed",
    };
  }

  // 2. Suppression may have flipped since enqueue (a bounce/complaint webhook fired).
  let blocked: boolean | null = null;
  let supErr: unknown = null;
  try {
    const res = await deps.isEmailSuppressed(dest);
    blocked = res.data;
    supErr = res.error;
  } catch (e) {
    supErr = e;
  }
  if (supErr) {
    return { action: "stop", error: "suppression_check_failed", terminal: false, countAs: "failed" };
  }
  if (blocked === true) {
    return { action: "stop", error: "email_suppressed", terminal: true, countAs: "suppressed" };
  }

  // 3. The COMPLETE live send policy (ADR 0008 §PS) — not just the event hook, which would
  //    leave contact revocation, tenant scope, a CHANGED address and preference-off unchecked.
  let stopReason: string | null = null;
  let stopErr: unknown = null;
  try {
    const res = await deps.memberStopReason(row.outbox_id);
    stopReason = res.data;
    stopErr = res.error;
  } catch (e) {
    stopErr = e;
  }
  if (stopErr) {
    return { action: "stop", error: "stop_policy_check_failed", terminal: false, countAs: "failed" };
  }
  if (stopReason) {
    // Terminal: authorisation for THIS notification is gone. Retrying cannot restore it, and a
    // retry loop against a revoked contact is exactly the spam this gate prevents.
    return { action: "stop", error: stopReason, terminal: true, countAs: "suppressed" };
  }

  return { action: "send", dest, subject, html };
}
