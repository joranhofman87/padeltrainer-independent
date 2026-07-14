import { differenceInMinutes } from "date-fns";
import { formatCurrency } from "@/lib/format";

/**
 * Calculate price for a slot based on hourly rate and duration
 */
export function calculateSlotPrice(
  hourlyRate: number,
  durationMinutes: number
): number {
  return (hourlyRate / 60) * durationMinutes;
}

/**
 * Calculate price from slot start/end times
 */
export function calculateSlotPriceFromTimes(
  hourlyRate: number,
  startTime: string | Date,
  endTime: string | Date
): number {
  const durationMinutes = differenceInMinutes(
    new Date(endTime),
    new Date(startTime)
  );
  return calculateSlotPrice(hourlyRate, durationMinutes);
}

/**
 * Calculate total price for multiple slots (e.g., a cyclus)
 */
export function calculateCyclusTotal(
  hourlyRate: number,
  slots: { start_time: string; end_time: string }[]
): number {
  return slots.reduce(
    (sum, slot) =>
      sum + calculateSlotPriceFromTimes(hourlyRate, slot.start_time, slot.end_time),
    0
  );
}

/**
 * Apply a discount to an amount
 */
export function applyDiscount(
  amount: number,
  discountType: "percentage" | "fixed",
  discountValue: number
): { finalAmount: number; discountAmount: number } {
  if (discountValue <= 0) {
    return { finalAmount: amount, discountAmount: 0 };
  }

  const discountAmount =
    discountType === "percentage"
      ? amount * (discountValue / 100)
      : discountValue;

  return {
    finalAmount: Math.max(0, amount - discountAmount),
    discountAmount: Math.min(discountAmount, amount), // Don't discount more than the total
  };
}

/**
 * Per-session price to QUOTE for a single-session booking, matching the server charge
 * exactly (computeSingleSlotPaymentAmount + sumSlotExtraCosts in
 * supabase/functions/_shared/booking-pricing.ts):
 *   - the base price_per_session is the PER-SEAT share (÷ max_participants) ONLY for a
 *     split_payment session ("paid individually"); every other session — including an
 *     individually-bookable NON-split cycle session — is quoted the full base ("paid at once");
 *   - positive extra costs are added on top, UNDIVIDED (negatives ignored, as the server does).
 * Returns null when the slot has no positive base price to quote.
 *
 * F01 (MASTER_AUDIT): division is driven by split_payment, not allow_single_booking (which
 * only governs whether a single booking is OFFERED). This is the single source the public
 * quote sites (PublicSlotRow, GuestBookingDialog, the cart) share, so they can never disagree
 * with each other or with the server charge.
 */
export function perSeatSessionPrice(slot: {
  price_per_session: number | null;
  max_participants?: number | null;
  split_payment?: boolean | null;
  extra_costs?: { price: number }[] | null;
}): number | null {
  const base = slot.price_per_session;
  if (base == null || !(base > 0)) return null;
  const maxP = slot.max_participants ?? 1;
  const perSeatBase = slot.split_payment === true && maxP > 1 ? base / maxP : base;
  const extras = Array.isArray(slot.extra_costs)
    ? slot.extra_costs.reduce((sum, ec) => {
        const p = Number(ec?.price);
        return sum + (Number.isFinite(p) && p > 0 ? p : 0);
      }, 0)
    : 0;
  return perSeatBase + extras;
}

/**
 * Format price with euro symbol.
 * @deprecated Prefer formatCurrency from '@/lib/format' (this now delegates to it).
 */
export function formatPrice(amount: number): string {
  return formatCurrency(amount);
}

/**
 * Get slot duration in minutes
 */
export function getSlotDurationMinutes(
  startTime: string | Date,
  endTime: string | Date
): number {
  return differenceInMinutes(new Date(endTime), new Date(startTime));
}
