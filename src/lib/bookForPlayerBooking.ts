import {
  applyFirstPayerDiscount,
  buildGuestBookingInsertRow,
  calculateSlotBookingPricing,
  normalizeSessionPrice,
  type GuestBookingInsertRow,
} from "@/lib/bookingPricing";
import {
  buildCyclePlayerPaymentAmounts,
  getSelectedGuestPlayerIds,
  normalizePayerId,
} from "@/lib/cyclePayerSelection";

export type BuildSingleSlotAddPlayerBookingsInput = {
  slotId: string;
  sessionPrice: number;
  splitPayment: boolean;
  existingActiveBookingCount: number;
  guestPlayerIds: string[];
  /** Non-split multi-player: guest who receives the full-price invoice. */
  payerGuestPlayerId?: string | null;
  notes: string | null;
  /** Discount subtracted from payer / first player only. */
  firstPlayerDiscount?: number;
  discountReason?: string | null;
};

export function buildSingleSlotAddPlayerBookings(
  input: BuildSingleSlotAddPlayerBookingsInput,
): GuestBookingInsertRow[] {
  const sessionPrice = normalizeSessionPrice(input.sessionPrice);
  const guestIds = getSelectedGuestPlayerIds(input.guestPlayerIds);
  const payerId = normalizePayerId(guestIds, input.payerGuestPlayerId);

  let paymentByGuest: Map<string, number>;

  if (input.splitPayment) {
    const pricing = calculateSlotBookingPricing({
      sessionPrice,
      splitPayment: true,
      existingActiveBookingCount: input.existingActiveBookingCount,
      newPlayerCount: guestIds.length,
    });
    paymentByGuest = new Map(
      guestIds.map((id, index) => [id, pricing.newPlayerAmounts[index] ?? 0]),
    );
  } else if (input.existingActiveBookingCount > 0) {
    const pricing = calculateSlotBookingPricing({
      sessionPrice,
      splitPayment: false,
      existingActiveBookingCount: input.existingActiveBookingCount,
      newPlayerCount: guestIds.length,
    });
    paymentByGuest = new Map(
      guestIds.map((id, index) => [id, pricing.newPlayerAmounts[index] ?? 0]),
    );
  } else {
    paymentByGuest = buildCyclePlayerPaymentAmounts({
      selectedPlayerIds: guestIds,
      payerGuestPlayerId: payerId,
      sessionPrice,
      splitPayment: false,
    });
  }

  const discount = input.firstPlayerDiscount ?? 0;
  const payerIndex = payerId ? guestIds.indexOf(payerId) : 0;

  return guestIds.map((guestPlayerId, index) => {
    const baseAmount = paymentByGuest.get(guestPlayerId) ?? 0;
    const paymentAmount = applyFirstPayerDiscount({
      playerIndex: index,
      paymentAmount: baseAmount,
      discountAmount: index === payerIndex || (payerIndex < 0 && index === 0) ? discount : 0,
    });

    const row = buildGuestBookingInsertRow({
      slotId: input.slotId,
      guestPlayerId,
      paymentAmount,
      sessionPrice,
      notes: input.notes,
    });

    const discountApplies =
      discount > 0 && (index === payerIndex || (payerIndex < 0 && index === 0));
    if (discountApplies) {
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
  payerGuestPlayerId?: string | null;
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
    payerGuestPlayerId: input.payerGuestPlayerId,
    notes: input.notes,
    firstPlayerDiscount: discount,
    discountReason: input.discountReason,
  });
}
