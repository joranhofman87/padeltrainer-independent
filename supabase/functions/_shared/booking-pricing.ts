/** Server-side booking price rules (mirrors BookLesson.tsx). */

export type SlotPricingInput = {
  start_time: string;
  end_time: string;
  price_per_session?: number | null;
  max_participants?: number | null;
  allow_single_booking?: boolean | null;
};

function slotDurationMinutes(startTime: string, endTime: string): number {
  const ms = new Date(endTime).getTime() - new Date(startTime).getTime();
  return Math.max(0, ms / 60000);
}

function calculateSlotPriceFromHourly(hourlyRate: number, durationMinutes: number): number {
  return (hourlyRate / 60) * durationMinutes;
}

/** Unit price for one session on a slot. */
export function resolveSlotUnitPrice(
  slot: SlotPricingInput,
  hourlyRate: number | null,
): number {
  if (slot.price_per_session != null && Number(slot.price_per_session) > 0) {
    return Number(slot.price_per_session);
  }
  const rate = hourlyRate ?? 0;
  return calculateSlotPriceFromHourly(rate, slotDurationMinutes(slot.start_time, slot.end_time));
}

/** Single-slot Mollie amount (quantity defaults to 1; one booking per call). */
export function computeSingleSlotPaymentAmount(
  slot: SlotPricingInput,
  hourlyRate: number | null,
  quantity = 1,
): number {
  const maxP = slot.max_participants || 1;
  const slotPrice = resolveSlotUnitPrice(slot, hourlyRate);
  const allowSingle = slot.allow_single_booking ?? false;
  const perSpotPrice = maxP > 1 && allowSingle ? slotPrice / maxP : slotPrice;
  const bookingQuantity = !allowSingle ? 1 : quantity;
  return allowSingle && maxP > 1 ? perSpotPrice * bookingQuantity : slotPrice;
}

export type ExtraCost = { price?: number | null; type?: string | null; description?: string | null };

/**
 * Total extra costs for ONE session — the sum of every positive extra cost on the slot. Mirrors what
 * the public UI shows (PublicSlotRow / GuestBookingDialog `extrasTotal = extra_costs.reduce(+price)`),
 * so the server charges exactly what the guest was quoted. Per-session for one session, so `one_time`
 * vs per-session collapse to the same single charge. (Multi-session cyclus billing of extras — where
 * one_time bills once and per-session bills per session, per auto-create-invoice — is a follow-up.)
 */
export function sumSlotExtraCosts(extraCosts: ExtraCost[] | null | undefined): number {
  if (!Array.isArray(extraCosts)) return 0;
  return extraCosts.reduce((sum, ec) => {
    const p = Number(ec?.price);
    return sum + (Number.isFinite(p) && p > 0 ? p : 0);
  }, 0);
}

export function computeCyclusTotalFromSlots(
  slots: SlotPricingInput[],
  hourlyRate: number | null,
): number {
  return slots.reduce((sum, s) => sum + resolveSlotUnitPrice(s, hourlyRate), 0);
}

export function applySplitPayment(total: number, playerCount: number): number {
  const n = Math.max(playerCount, 1);
  return Math.round((total / n) * 100) / 100;
}

export function amountsMatch(expected: number, actual: number, tolerance = 0.01): boolean {
  return Math.abs(expected - actual) <= tolerance;
}

export function parseMollieAmountValue(value: string | number | undefined): number {
  if (value === undefined || value === null) return NaN;
  return typeof value === "number" ? value : parseFloat(String(value));
}
