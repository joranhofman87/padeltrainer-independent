/**
 * Server-side slot tier + booking-eligibility decisions for the tiered
 * rebooking feature. Mirrors the read-time visibility logic in
 * src/lib/priorityClaims.ts (getSlotVisibility) but is framed for ENFORCEMENT:
 * deciding whether a given player may create a booking for a slot.
 *
 * This is the single source of truth intended to be used by a BEFORE INSERT
 * trigger on bookings (and/or an edge function), because today bookings are
 * inserted directly from the client and the bookings RLS only checks
 * `player_id = self` — it does NOT enforce the priority/member window or slot
 * capacity, so those can be bypassed.
 */

export type SlotTier = "priority" | "members" | "public" | "hidden";

export type ResolveSlotTierInput = {
  priorityWindowEndsAt: string | null | undefined;
  /** Any claim still pending for the slot keeps it in the priority tier. */
  hasPendingClaim: boolean;
  memberWindowEndsAt: string | null | undefined;
  publicReleaseStatus: string | null | undefined;
  now?: Date;
};

/**
 * Resolve the slot's current tier, independent of who is viewing.
 * - priority: only entitled claim-holders may book
 * - members: only source-cycle members may book
 * - hidden: owner-only (held / pending admin review)
 * - public: anyone may book
 */
export function resolveSlotTier(input: ResolveSlotTierInput): SlotTier {
  const nowMs = (input.now ?? new Date()).getTime();

  const priorityActive = !!input.priorityWindowEndsAt &&
    new Date(input.priorityWindowEndsAt).getTime() > nowMs &&
    input.hasPendingClaim;
  if (priorityActive) return "priority";

  const memberActive = !!input.memberWindowEndsAt &&
    new Date(input.memberWindowEndsAt).getTime() > nowMs;
  if (memberActive) return "members";

  if (
    input.publicReleaseStatus === "held" ||
    input.publicReleaseStatus === "pending_admin_review"
  ) {
    return "hidden";
  }
  return "public";
}

export type BookingEligibilityInput = {
  tier: SlotTier;
  /** The booking player holds a non-declined claim for this slot. */
  playerHoldsClaim: boolean;
  /** The booking player was a member of the slot's source cycle. */
  isCycleMember: boolean;
  /** Non-cancelled bookings already on the slot. */
  seatsTaken: number;
  /** Slot capacity (defaults to 1 when null/undefined). */
  maxParticipants: number | null | undefined;
};

export type BookingEligibilityResult =
  | { ok: true }
  | { ok: false; reason: "full" | "priority_restricted" | "members_only" | "not_released" };

/**
 * Decide whether a player-initiated booking may be created. Trainer/academy/
 * club-manager-created bookings are NOT subject to this (they own the slot) and
 * should bypass this check at the call site.
 */
export function canPlayerBookSlot(input: BookingEligibilityInput): BookingEligibilityResult {
  const capacity = input.maxParticipants ?? 1;
  if (input.seatsTaken >= capacity) {
    return { ok: false, reason: "full" };
  }
  switch (input.tier) {
    case "priority":
      return input.playerHoldsClaim ? { ok: true } : { ok: false, reason: "priority_restricted" };
    case "members":
      return input.isCycleMember ? { ok: true } : { ok: false, reason: "members_only" };
    case "hidden":
      return { ok: false, reason: "not_released" };
    case "public":
      return { ok: true };
  }
}
