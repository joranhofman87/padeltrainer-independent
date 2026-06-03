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

/** Whether generateBulkSlots should call notify-followers (trainer self-service only). */
export function shouldInvokeNotifyFollowersOnBulkGenerate(params: {
  hasPublicSlots?: boolean;
  academyId?: string | null;
}): boolean {
  const hasPublicSlots = params.hasPublicSlots ?? true;
  return hasPublicSlots && !shouldSkipNotifyFollowersInAcademyMode(params.academyId);
}
