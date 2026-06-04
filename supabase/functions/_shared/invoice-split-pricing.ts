/** Shared invoice split rules (keep in sync with src/lib/invoiceSplitPricing.ts). */

export const SPLIT_SHARE_TOLERANCE = 0.02;

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export type InvoiceSplitPriceInput = {
  paymentAmount: number | null | undefined;
  slotPrice: number | null | undefined;
  splitAmongPlayers: number | null | undefined;
};

export function isBookingAmountAlreadySplitShare(input: InvoiceSplitPriceInput): boolean {
  const { paymentAmount, slotPrice, splitAmongPlayers } = input;
  if (paymentAmount == null || paymentAmount <= 0) return false;
  if (!splitAmongPlayers || splitAmongPlayers <= 1) return false;
  if (!slotPrice || slotPrice <= 0) return false;
  return Math.abs(paymentAmount * splitAmongPlayers - slotPrice) <= SPLIT_SHARE_TOLERANCE;
}

export function resolveInvoiceUnitPrice(input: InvoiceSplitPriceInput): number {
  const { paymentAmount, slotPrice, splitAmongPlayers } = input;
  if (paymentAmount != null && paymentAmount > 0) {
    return round2(paymentAmount);
  }
  const base = slotPrice != null && slotPrice > 0 ? slotPrice : 0;
  if (base <= 0) return 0;
  if (splitAmongPlayers != null && splitAmongPlayers > 1) {
    return round2(base / splitAmongPlayers);
  }
  return round2(base);
}

export type BookingWithSlotPrice = {
  payment_amount?: number | null;
  availability_slots?: { price_per_session?: number | null } | null;
};

export function bookingsUseSplitShareAmounts(
  bookings: BookingWithSlotPrice[],
  splitAmongPlayers: number | null | undefined,
): boolean {
  if (!splitAmongPlayers || splitAmongPlayers <= 1 || bookings.length === 0) {
    return false;
  }
  const slotPrice = bookings[0].availability_slots?.price_per_session;
  const amounts = bookings
    .map((b) => b.payment_amount)
    .filter((a): a is number => a != null && a > 0);
  if (amounts.length === 0) return false;
  const first = amounts[0];
  if (!amounts.every((a) => Math.abs(a - first) <= SPLIT_SHARE_TOLERANCE)) {
    return false;
  }
  return isBookingAmountAlreadySplitShare({
    paymentAmount: first,
    slotPrice,
    splitAmongPlayers,
  });
}

export function splitAmongPlayersForInvoiceCreate(
  bookings: BookingWithSlotPrice[],
  requestedSplit: number | null | undefined,
): number | null {
  if (requestedSplit == null || requestedSplit <= 1) return null;
  if (bookingsUseSplitShareAmounts(bookings, requestedSplit)) return null;
  return requestedSplit;
}
