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

/**
 * True when the extra-cost line items must NOT be appended to an invoice because the
 * booking's payment_amount ALREADY includes them. This is the single-slot pay-first case
 * (create-mollie-payment single-slot + create-guest-slot-payment): the online charge bakes
 * sumSlotExtraCosts into payment_amount, so re-appending extras would overstate the invoice
 * (authed path, P1-5) or double-count them (guest path, P2-7).
 *
 * Only fires for a NON-cyclus booking set where EVERY booking carries the flag. Cyclus /
 * multi-slot charges never include extras and are never flagged, so extras keep being
 * appended there; manual (non-pay-first) bookings are never flagged either.
 */
export function shouldSkipExtrasForPaidExtrasBookings(
  bookings: { amount_includes_extras?: boolean | null }[],
  allSameCyclus: boolean,
): boolean {
  if (allSameCyclus) return false;
  if (!bookings || bookings.length === 0) return false;
  return bookings.every((b) => b?.amount_includes_extras === true);
}

export function computeCyclusTotalFromSlots(
  slots: SlotPricingInput[],
  hourlyRate: number | null,
): number {
  return slots.reduce((sum, s) => sum + resolveSlotUnitPrice(s, hourlyRate), 0);
}

/**
 * Cycle-level extra_costs total, PRE-split, to fold into the cyclus charge so it collects exactly
 * what the invoice bills. Mirrors auto-create-invoice / buildCycleLineItems: a `one_time` extra is
 * billed ONCE for the whole cycle, a per-session extra once per session. The caller adds this to the
 * base cyclus total and then applySplitPayment divides the whole thing by the frozen capacity —
 * exactly as the invoice divides each extra line by split_count. Without this the split-cyclus charge
 * dropped extras entirely while the invoice appended them ÷ N (audit Batch 2 — charge/invoice extras
 * must agree; owner decision: charge the extras).
 */
export function computeCyclusExtrasTotal(
  extraCosts: ExtraCost[] | null | undefined,
  sessionCount: number,
): number {
  if (!Array.isArray(extraCosts)) return 0;
  const sessions = Math.max(0, sessionCount);
  return extraCosts.reduce((sum, ec) => {
    const p = Number(ec?.price);
    if (!Number.isFinite(p) || p <= 0) return sum;
    const qty = ec?.type === "one_time" ? 1 : sessions;
    return sum + p * qty;
  }, 0);
}

export function applySplitPayment(total: number, playerCount: number): number {
  const n = Math.max(playerCount, 1);
  return Math.round((total / n) * 100) / 100;
}

export type RebookPaymentMode = "upfront" | "deferred_split";

/**
 * Projected invoice total for ONE rebook series/group shown in the wizard's step-2 review
 * (assumes everyone accepts; null when no price is set).
 *
 * A rebook group ALWAYS pays the court price ONCE for the cycle → P × S, regardless of payment
 * mode or split_payment. The mode only changes WHO/HOW, not the group total:
 *  - upfront (group-captain): ONE captain pays the full court up front → create-group-rebook-invoice
 *    mints one invoice at P × S (splitAmongPlayers:1).
 *  - deferred_split: the court price is split among the committed group at cycle start → each of N
 *    committers is invoiced (P × S) / N, so the group total is still P × S. The deferred cron
 *    (generate-cycle-commitment-invoices → buildCommitmentInvoicePlan) ALWAYS splits by group
 *    headcount and never reads split_payment, so !split does NOT bill each player the full price.
 *
 * Hence: NEVER × N. `players`/`splitPayment`/`paymentMode` are accepted for signature stability but
 * do not change the total.
 */
export function projectRebookGroupInvoiceTotal(opts: {
  pricePerSession: number | null;
  sessions: number;
  players: number;
  splitPayment: boolean;
  paymentMode: RebookPaymentMode;
}): number | null {
  const { pricePerSession: P, sessions } = opts;
  if (P == null) return null;
  return P * sessions;
}

/**
 * G5 — the split-payment divisor is the cycle's COURT CAPACITY, not the live
 * player count. Freezing to capacity makes the divisor a pure function of the slot
 * rows: it can't drift as the cohort forms mid-checkout (the old live-count race),
 * and no player is ever overcharged (each pays exactly total ÷ seats; the academy
 * absorbs any empty seat). Every split site (Mollie charge, guest charge, invoice
 * split_count) uses THIS so they can never disagree.
 *
 * Rule: MAX(max_participants) across the cycle's slots, each coalesced to ≥1.
 *  - MAX (not first/min) is order-independent + deterministic across call sites and,
 *    when a cycle's slots have non-uniform capacity (a data anomaly), never
 *    overcharges (largest divisor → smallest per-player share).
 *  - null/0 capacity → 1. A divisor of 1 means "no split" (applySplitPayment returns
 *    the full total).
 */
export function resolveSplitDivisorFromSlots(slots: { max_participants?: number | null }[]): number {
  const caps = (slots ?? []).map((s) => Math.max(1, Number(s?.max_participants) || 1));
  return caps.length ? Math.max(...caps) : 1;
}

/** True when a cycle's slots disagree on capacity — a data anomaly worth logging (never overcharges). */
export function hasNonUniformCapacity(slots: { max_participants?: number | null }[]): boolean {
  const caps = new Set((slots ?? []).map((s) => Math.max(1, Number(s?.max_participants) || 1)));
  return caps.size > 1;
}

export function amountsMatch(expected: number, actual: number, tolerance = 0.01): boolean {
  return Math.abs(expected - actual) <= tolerance;
}

export function parseMollieAmountValue(value: string | number | undefined): number {
  if (value === undefined || value === null) return NaN;
  return typeof value === "number" ? value : parseFloat(String(value));
}
