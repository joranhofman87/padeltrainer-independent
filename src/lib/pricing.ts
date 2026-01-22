import { differenceInMinutes } from "date-fns";

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
 * Format price with euro symbol
 */
export function formatPrice(amount: number): string {
  return `€${amount.toFixed(2)}`;
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
