import { round2 } from "@/lib/invoiceCalc";
import { calculateSlotPrice } from "@/lib/pricing";

export type SlotBookingPricingInput = {
  sessionPrice: number | null | undefined;
  splitPayment: boolean;
  existingActiveBookingCount: number;
  newPlayerCount: number;
};

export type SlotBookingPricingResult = {
  /** Normalized session price (0 if missing). */
  sessionPrice: number;
  /** Amount each paying participant owes after this operation. */
  perPlayerAmount: number;
  /** Per-new-player payment_amount values (length = newPlayerCount). */
  newPlayerAmounts: number[];
  /** When split + existing bookings: amount to set on rebalanceable existing rows. */
  existingBookingsNewAmount: number | null;
  /** Whether caller should update existing unpaid bookings to existingBookingsNewAmount. */
  shouldRebalanceExisting: boolean;
};

export function normalizeSessionPrice(
  sessionPrice: number | null | undefined,
): number {
  if (sessionPrice == null || Number.isNaN(sessionPrice)) {
    return 0;
  }
  return Math.max(0, sessionPrice);
}

/**
 * Count bookings that participate in slot pricing (confirmed/pending only).
 */
export function countActiveBookings(
  bookings: { status?: string }[] | null | undefined,
): number {
  if (!bookings?.length) {
    return 0;
  }
  return bookings.filter(
    (b) => b.status === "confirmed" || b.status === "pending",
  ).length;
}

/**
 * Compute payment_amount for new bookings and optional rebalance of existing ones.
 */
export function calculateSlotBookingPricing(
  input: SlotBookingPricingInput,
): SlotBookingPricingResult {
  const sessionPrice = normalizeSessionPrice(input.sessionPrice);
  const existing = Math.max(0, input.existingActiveBookingCount);
  const newCount = Math.max(0, input.newPlayerCount);

  if (input.splitPayment) {
    const totalParticipants = existing + newCount;
    const perPlayerAmount =
      totalParticipants > 0 ? round2(sessionPrice / totalParticipants) : 0;
    const newPlayerAmounts = Array.from({ length: newCount }, () => perPlayerAmount);

    return {
      sessionPrice,
      perPlayerAmount,
      newPlayerAmounts,
      existingBookingsNewAmount: existing > 0 ? perPlayerAmount : null,
      shouldRebalanceExisting: existing > 0 && newCount > 0,
    };
  }

  // Non-split: one payer carries full session price; companions are €0.
  const newPlayerAmounts: number[] = [];
  if (existing === 0) {
    for (let i = 0; i < newCount; i++) {
      newPlayerAmounts.push(i === 0 ? sessionPrice : 0);
    }
  } else {
    for (let i = 0; i < newCount; i++) {
      newPlayerAmounts.push(0);
    }
  }

  const perPlayerAmount = existing > 0 ? 0 : sessionPrice;

  return {
    sessionPrice,
    perPlayerAmount,
    newPlayerAmounts,
    existingBookingsNewAmount: null,
    shouldRebalanceExisting: false,
  };
}

/** Booking row is safe to rebalance (unpaid, not external). */
export function canRebalanceBooking(booking: {
  paymentStatus?: string | null;
  paidExternally?: boolean | null;
}): boolean {
  if (booking.paidExternally) {
    return false;
  }
  return booking.paymentStatus !== "paid";
}

export type BookingPaymentFields = {
  original_amount: number;
  payment_amount: number;
  discount_amount: number;
};

export function buildBookingPaymentFields(
  paymentAmount: number,
  sessionPrice: number,
): BookingPaymentFields {
  return {
    original_amount: sessionPrice,
    payment_amount: paymentAmount,
    discount_amount: 0,
  };
}

/** Whether slot detail add-player should use configured slot price (not hourly rate). */
export function usesConfiguredSlotSessionPrice(
  pricePerSession: number | null | undefined,
): boolean {
  return normalizeSessionPrice(pricePerSession) > 0;
}

export function getRebalanceBookingIds(
  bookedPlayers: {
    bookingId: string;
    paymentStatus?: string | null;
    paidExternally?: boolean | null;
  }[],
): string[] {
  return bookedPlayers
    .filter((p) => canRebalanceBooking(p))
    .map((p) => p.bookingId);
}

export type GuestBookingInsertRow = {
  slot_id: string;
  guest_player_id: string;
  status: "confirmed";
  payment_status: "pending";
  original_amount: number;
  payment_amount: number;
  discount_amount: number;
  discount_reason: string | null;
  notes: string | null;
};

/** Session price from slot config, or hourly rate × duration when unset. */
export function resolveSlotSessionPrice(
  pricePerSession: number | null | undefined,
  hourlyRate: number,
  durationMinutes: number,
): number {
  const configured = normalizeSessionPrice(pricePerSession);
  if (configured > 0) {
    return configured;
  }
  return calculateSlotPrice(hourlyRate, durationMinutes);
}

export type ApplyFirstPayerDiscountInput = {
  playerIndex: number;
  paymentAmount: number;
  /** Discount applied only to the first selected player (index 0). */
  discountAmount: number;
};

export function applyFirstPayerDiscount(input: ApplyFirstPayerDiscountInput): number {
  if (input.playerIndex !== 0 || input.discountAmount <= 0) {
    return input.paymentAmount;
  }
  return Math.max(0, round2(input.paymentAmount - input.discountAmount));
}

export function buildGuestBookingInsertRow(params: {
  slotId: string;
  guestPlayerId: string;
  paymentAmount: number;
  sessionPrice: number;
  notes: string | null;
}): GuestBookingInsertRow {
  const fields = buildBookingPaymentFields(params.paymentAmount, params.sessionPrice);
  return {
    slot_id: params.slotId,
    guest_player_id: params.guestPlayerId,
    status: "confirmed",
    payment_status: "pending",
    original_amount: fields.original_amount,
    payment_amount: fields.payment_amount,
    discount_amount: fields.discount_amount,
    discount_reason: null,
    notes: params.notes,
  };
}
