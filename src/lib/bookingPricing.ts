import { round2 } from "@/lib/invoiceCalc";
import { calculateSlotPrice } from "@/lib/pricing";

export type SlotBookingPricingInput = {
  sessionPrice: number | null | undefined;
  splitPayment: boolean;
  existingActiveBookingCount: number;
  newPlayerCount: number;
  /**
   * G5 frozen-capacity divisor for split payment: the slot's `max_participants`. When supplied
   * (> 1) it — NOT the live headcount — divides the session price, so a split share never drifts
   * with the cohort and always matches the invoice/recalc/charge paths (`resolveSplitDivisor`).
   * Omitted / ≤ 1 → legacy behaviour (divide by the live `existing + new` total).
   */
  slotCapacity?: number | null;
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
    // G5: divide by the FROZEN court capacity when known (> 1), never the live headcount, so the
    // per-player share matches the invoice/recalc/charge paths (resolveSplitDivisor) and a court of
    // N always bills slot/N regardless of how many are enrolled yet. Falls back to the live total
    // only when capacity is unknown, preserving old behaviour for callers that can't supply it.
    const capacity = Math.max(0, Number(input.slotCapacity) || 0);
    const divisor = capacity > 1 ? capacity : existing + newCount;
    const perPlayerAmount = divisor > 0 ? round2(sessionPrice / divisor) : 0;
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

export type RebalanceAmountGroup = {
  /** payment_amount to write for every booking id in this group. */
  paymentAmount: number;
  bookingIds: string[];
};

/**
 * New payment_amounts for existing rows when a split share changes. Each row
 * keeps its negotiated discount — payment = max(0, share − discount) — so
 * discount_amount / discount_reason must NOT be rewritten by the caller.
 * Grouped by resulting amount so callers can batch the updates.
 */
export function buildRebalanceAmountGroups(
  bookings: { id: string; discount_amount?: number | null }[],
  newShare: number,
): RebalanceAmountGroup[] {
  const byAmount = new Map<number, string[]>();
  for (const booking of bookings) {
    const discount =
      typeof booking.discount_amount === "number" &&
      Number.isFinite(booking.discount_amount)
        ? Math.max(0, booking.discount_amount)
        : 0;
    const paymentAmount = Math.max(0, round2(newShare - discount));
    const ids = byAmount.get(paymentAmount) ?? [];
    ids.push(booking.id);
    byAmount.set(paymentAmount, ids);
  }
  return Array.from(byAmount.entries(), ([paymentAmount, bookingIds]) => ({
    paymentAmount,
    bookingIds,
  }));
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
  /** Kept for call-site clarity; targeting is decided by discountAmount. */
  playerIndex: number;
  paymentAmount: number;
  /** Discount to subtract; the CALLER passes 0 for non-payer rows. */
  discountAmount: number;
};

export function applyFirstPayerDiscount(input: ApplyFirstPayerDiscountInput): number {
  // The caller decides WHO is discounted (it passes discountAmount only for the
  // payer's row). Gating on playerIndex===0 here silently dropped the discount
  // whenever the chosen payer wasn't the first-selected player — overcharging
  // the customer while the books recorded a phantom discount.
  if (input.discountAmount <= 0) {
    return input.paymentAmount;
  }
  return Math.max(0, round2(input.paymentAmount - input.discountAmount));
}

export type AddPlayerPricingPreviewSlot = {
  /** Resolved session price (see resolveSlotSessionPrice). */
  sessionPrice: number;
  existingActiveBookingCount: number;
};

export type AddPlayerPricingPreviewInput = {
  /** Slots that will be booked; the discount lands on the first one. */
  slots: AddPlayerPricingPreviewSlot[];
  splitPayment: boolean;
  newPlayerCount: number;
  /** Selection-order index of the invoice payer (defaults to the first player). */
  payerIndex?: number;
  discountType: "percentage" | "fixed";
  discountValue: number;
};

export type AddPlayerPricingPreview = {
  /** Sum of the payment_amounts the new bookings will get, before discount. */
  subtotal: number;
  /** Discount actually granted — clamped to the payer's first-slot amount, like booking. */
  discountAmount: number;
  /** subtotal − discountAmount: what the new players will owe in total. */
  total: number;
  /** Each new player's owed total across all slots (selection order), discount included. */
  perPlayerTotals: number[];
  /** Uniform per-player-per-session amount when identical everywhere, else null. */
  perPlayerSessionAmount: number | null;
  /** Pass as firstPlayerDiscount to build*AddPlayerBookings so booked rows equal this preview. */
  firstPlayerDiscount: number;
};

/**
 * Pure preview of what buildSingleSlot/CyclusSlotAddPlayerBookings will insert,
 * for the booking dialog's price summary. Mirrors the booking-time model: the
 * session price is charged ONCE per slot — split equally or carried by the
 * payer — never multiplied by player count, and a percentage discount is taken
 * over the real subtotal.
 */
export function calculateAddPlayerPricingPreview(
  input: AddPlayerPricingPreviewInput,
): AddPlayerPricingPreview {
  const newCount = Math.max(0, input.newPlayerCount);
  const payerIndex =
    input.payerIndex != null && input.payerIndex >= 0 && input.payerIndex < newCount
      ? input.payerIndex
      : 0;

  // amounts[slotIndex][playerIndex], identical to the build* insert rows.
  const amountsPerSlot = input.slots.map((slot) => {
    const pricing = calculateSlotBookingPricing({
      sessionPrice: slot.sessionPrice,
      splitPayment: input.splitPayment,
      existingActiveBookingCount: slot.existingActiveBookingCount,
      newPlayerCount: newCount,
    });
    if (input.splitPayment || slot.existingActiveBookingCount > 0) {
      return pricing.newPlayerAmounts;
    }
    // Non-split empty slot: the chosen payer (not necessarily the first
    // selected player) carries the full session price.
    return Array.from({ length: newCount }, (_, i) =>
      i === payerIndex ? pricing.sessionPrice : 0,
    );
  });

  const perPlayerBaseTotals = Array.from({ length: newCount }, (_, playerIdx) =>
    round2(amountsPerSlot.reduce((sum, amounts) => sum + (amounts[playerIdx] ?? 0), 0)),
  );
  const subtotal = round2(perPlayerBaseTotals.reduce((sum, amount) => sum + amount, 0));

  const requestedDiscount =
    input.discountValue > 0
      ? input.discountType === "percentage"
        ? subtotal * (input.discountValue / 100)
        : input.discountValue
      : 0;
  // Booking subtracts the discount from the payer's first-slot row only and
  // clamps it at €0 — it can never exceed what that single row carries.
  const payerFirstSlotAmount = amountsPerSlot[0]?.[payerIndex] ?? 0;
  const discountAmount = round2(Math.min(requestedDiscount, payerFirstSlotAmount));

  const perPlayerTotals = perPlayerBaseTotals.map((playerTotal, idx) =>
    idx === payerIndex ? round2(playerTotal - discountAmount) : playerTotal,
  );
  const total = round2(subtotal - discountAmount);

  const flatAmounts = amountsPerSlot.flat();
  const perPlayerSessionAmount =
    flatAmounts.length > 0 && flatAmounts.every((amount) => amount === flatAmounts[0])
      ? flatAmounts[0]
      : null;

  return {
    subtotal,
    discountAmount,
    total,
    perPlayerTotals,
    perPlayerSessionAmount,
    firstPlayerDiscount: discountAmount,
  };
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
