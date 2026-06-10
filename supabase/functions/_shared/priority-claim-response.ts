/**
 * Pure decision for responding to a priority claim (accept / decline).
 * Mirrors the respond_to_priority_claim RPC so the accept/decline rules are
 * unit-tested. "accept" commits the player to the next cycle (a confirmed,
 * unpaid booking); "decline" releases the spot. Capacity is enforced on accept.
 */

export type PriorityClaimAction = "accept" | "decline";

export type PriorityClaimResponseInput = {
  action: PriorityClaimAction;
  claimStatus: string;
  priorityWindowEndsAt: string | null | undefined;
  /** Non-cancelled bookings already on the slot (only relevant for accept). */
  seatsTaken: number;
  maxParticipants: number | null | undefined;
  now?: Date;
};

export type PriorityClaimResponseResult =
  | { ok: true; status: "claimed" | "declined" }
  | { ok: false; reason: "already_responded" | "window_expired" | "slot_full" };

export function evaluatePriorityClaimResponse(
  input: PriorityClaimResponseInput,
): PriorityClaimResponseResult {
  if (input.claimStatus !== "pending") {
    return { ok: false, reason: "already_responded" };
  }

  const nowMs = (input.now ?? new Date()).getTime();
  if (
    input.priorityWindowEndsAt &&
    new Date(input.priorityWindowEndsAt).getTime() < nowMs
  ) {
    return { ok: false, reason: "window_expired" };
  }

  if (input.action === "decline") {
    return { ok: true, status: "declined" };
  }

  // accept → commit, subject to capacity
  const capacity = input.maxParticipants ?? 1;
  if (input.seatsTaken >= capacity) {
    return { ok: false, reason: "slot_full" };
  }
  return { ok: true, status: "claimed" };
}
