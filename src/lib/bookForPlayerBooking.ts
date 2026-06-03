import {
  applyFirstPayerDiscount,
  buildGuestBookingInsertRow,
  calculateSlotBookingPricing,
  type GuestBookingInsertRow,
} from "@/lib/bookingPricing";

export type BuildSingleSlotAddPlayerBookingsInput = {
  slotId: string;
  sessionPrice: number;
  splitPayment: boolean;
  existingActiveBookingCount: number;
  guestPlayerIds: string[];
  notes: string | null;
  /** Discount subtracted from first selected player only. */
  firstPlayerDiscount?: number;
  discountReason?: string | null;
};

export function buildSingleSlotAddPlayerBookings(
  input: BuildSingleSlotAddPlayerBookingsInput,
): GuestBookingInsertRow[] {
  const pricing = calculateSlotBookingPricing({
    sessionPrice: input.sessionPrice,
    splitPayment: input.splitPayment,
    existingActiveBookingCount: input.existingActiveBookingCount,
    newPlayerCount: input.guestPlayerIds.length,
  });

  const discount = input.firstPlayerDiscount ?? 0;

  return input.guestPlayerIds.map((guestPlayerId, index) => {
    const baseAmount = pricing.newPlayerAmounts[index] ?? 0;
    const paymentAmount = applyFirstPayerDiscount({
      playerIndex: index,
      paymentAmount: baseAmount,
      discountAmount: discount,
    });

    const row = buildGuestBookingInsertRow({
      slotId: input.slotId,
      guestPlayerId,
      paymentAmount,
      sessionPrice: pricing.sessionPrice,
      notes: input.notes,
    });

    if (index === 0 && discount > 0) {
      return {
        ...row,
        discount_amount: discount,
        discount_reason: input.discountReason ?? null,
      };
    }

    return row;
  });
}

export type BuildCyclusSlotAddPlayerBookingsInput = {
  slotId: string;
  sessionPrice: number;
  splitPayment: boolean;
  existingActiveBookingCount: number;
  guestPlayerIds: string[];
  notes: string | null;
  /** Applied on first cyclus slot only, first player only. */
  firstPlayerDiscount?: number;
  discountReason?: string | null;
  isFirstCyclusSlot: boolean;
};

export function buildCyclusSlotAddPlayerBookings(
  input: BuildCyclusSlotAddPlayerBookingsInput,
): GuestBookingInsertRow[] {
  const discount =
    input.isFirstCyclusSlot && (input.firstPlayerDiscount ?? 0) > 0
      ? input.firstPlayerDiscount!
      : 0;

  return buildSingleSlotAddPlayerBookings({
    slotId: input.slotId,
    sessionPrice: input.sessionPrice,
    splitPayment: input.splitPayment,
    existingActiveBookingCount: input.existingActiveBookingCount,
    guestPlayerIds: input.guestPlayerIds,
    notes: input.notes,
    firstPlayerDiscount: discount,
    discountReason: input.discountReason,
  });
}
