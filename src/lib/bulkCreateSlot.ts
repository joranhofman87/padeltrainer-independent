import type { BulkGenerateBookingOutcome } from "@/lib/academyCreateSlot";
import { shouldSkipNotifyFollowersInAcademyMode } from "@/lib/academyCreateSlot";

/** Default bulk slot ownership fields set when seeding academy/trainer create-cycle. */
export type DefaultBulkSlotOwnership = {
  academyProfileId: string | null;
  trainerId: string | null;
};

export function buildDefaultBulkSlotOwnership(
  trainerId: string | null,
  academyId?: string | null,
): DefaultBulkSlotOwnership {
  return {
    academyProfileId: academyId ?? null,
    trainerId,
  };
}

/** Show destructive partial-success toast after slots exist but guest bookings failed. */
export function shouldShowBulkBookingPartialFailureToast(
  outcome: BulkGenerateBookingOutcome,
): boolean {
  return outcome === "partial_failure";
}

/** Show players-added toast only when bookings were actually created. */
export function shouldShowBulkPlayersAddedToast(
  outcome: BulkGenerateBookingOutcome,
  totalBookingsCreated: number,
): boolean {
  return outcome === "success" && totalBookingsCreated > 0;
}

/**
 * Whether generateBulkSlots should call notify-followers (trainer self-service only).
 *
 * `hasPublicSlots` is REQUIRED and has no default. It used to default to `true`, and the caller
 * passed a hardcoded `true` besides — so a batch in which every entry was marked private still
 * notified followers, and `slot_count` counted the private slots. A defaulted "assume public" is
 * exactly the shape that let that survive review, so the parameter is now mandatory and the caller
 * must derive it from the rows the DATABASE returned as public.
 */
export function shouldInvokeNotifyFollowersOnBulkGenerate(params: {
  hasPublicSlots: boolean;
  academyId?: string | null;
}): boolean {
  return params.hasPublicSlots && !shouldSkipNotifyFollowersInAcademyMode(params.academyId);
}
