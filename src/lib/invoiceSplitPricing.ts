import { round2 } from '@/lib/invoiceCalc';

/** Max difference allowed when checking payment_amount × N ≈ slot price. */
export const SPLIT_SHARE_TOLERANCE = 0.02;

export type InvoiceSplitPriceInput = {
  paymentAmount: number | null | undefined;
  slotPrice: number | null | undefined;
  splitAmongPlayers: number | null | undefined;
};

/**
 * True when payment_amount is already a per-recipient share of the full slot price.
 * Example: 19 × 4 ≈ 76.
 */
export function isBookingAmountAlreadySplitShare(input: InvoiceSplitPriceInput): boolean {
  const { paymentAmount, slotPrice, splitAmongPlayers } = input;
  if (paymentAmount == null || paymentAmount <= 0) return false;
  if (!splitAmongPlayers || splitAmongPlayers <= 1) return false;
  if (!slotPrice || slotPrice <= 0) return false;
  return Math.abs(paymentAmount * splitAmongPlayers - slotPrice) <= SPLIT_SHARE_TOLERANCE;
}

/**
 * Invoice line unit price for one session/booking.
 * - payment_amount > 0: authoritative per-recipient amount (never divided again).
 * - else: slot price, divided once when splitAmongPlayers > 1.
 */
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

/**
 * Mirror of supabase/functions/_shared/booking-pricing.ts shouldSkipExtrasForPaidExtrasBookings.
 * True when the extra-cost lines must NOT be appended because the booking's payment_amount
 * already includes them (single-slot pay-first). Non-cyclus + every booking flagged.
 */
export function shouldSkipExtrasForPaidExtrasBookings(
  bookings: { amount_includes_extras?: boolean | null }[],
  allSameCyclus: boolean,
): boolean {
  if (allSameCyclus) return false;
  if (!bookings || bookings.length === 0) return false;
  return bookings.every((b) => b?.amount_includes_extras === true);
}

export type BookingWithSlotPrice = {
  payment_amount?: number | null;
  availability_slots?: { price_per_session?: number | null } | null;
};

/** True when all non-zero payment_amount rows are already split shares for this cycle. */
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

/**
 * Whether auto-create-invoice should receive splitAmongPlayers for price division.
 * Omit when bookings already store per-recipient shares (per-player invoice batches).
 */
export function splitAmongPlayersForInvoiceCreate(
  bookings: BookingWithSlotPrice[],
  requestedSplit: number | null | undefined,
): number | null {
  if (requestedSplit == null || requestedSplit <= 1) return null;
  if (bookingsUseSplitShareAmounts(bookings, requestedSplit)) return null;
  return requestedSplit;
}
