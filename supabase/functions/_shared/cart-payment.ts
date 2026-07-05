/**
 * Multi-session cart booking — the pure validation/pricing core of
 * create-guest-cart-payment (docs/audits/MULTI_SESSION_CART_BOOKING_AUDIT.md §6.2).
 *
 * Lives in _shared so the money-deciding rules are covered by the CI Deno test gate
 * (only _shared/*.test.ts runs in CI); the edge function stays a thin I/O wrapper.
 *
 * Trust model: the client supplies ONLY the slot-id list and its own contact details.
 * Everything here re-derives from server-read slot rows — prices, ownership, visibility,
 * eligibility. Refusals carry the offending slot ids so the cart UI can prune exactly
 * the stale items and retry ({ error, slotIds } — the cart's error contract).
 */
import {
  computeSingleSlotPaymentAmount,
  sumSlotExtraCosts,
  type ExtraCost,
  type SlotPricingInput,
} from "./booking-pricing.ts";
import { resolveSlotTier } from "./slot-tier.ts";

/** Bound on cart size: abuse + Mollie body size. Reject (never silently truncate). */
export const CART_MAX_ITEMS = 20;

/** The slot columns the cart reads server-side (mirrors create-guest-slot-payment's select). */
export type CartSlotRow = {
  id: string;
  trainer_id: string | null;
  academy_profile_id: string | null;
  cyclus_id: string | null;
  cyclus_name?: string | null;
  price_per_session: number | null;
  start_time: string;
  end_time: string;
  max_participants: number | null;
  allow_single_booking: boolean | null;
  split_payment: boolean | null;
  extra_costs: ExtraCost[] | null;
  is_public: boolean | null;
  priority_window_ends_at: string | null;
  member_window_ends_at: string | null;
  public_release_status: string | null;
};

export type CartRefusal = { error: string; slotIds?: string[] };

/**
 * Parse + normalize the client's slotIds. Dedupes (a double-tap must not double-charge),
 * refuses non-string junk and oversized carts.
 */
export function normalizeCartSlotIds(input: unknown): { slotIds: string[] } | CartRefusal {
  if (!Array.isArray(input)) return { error: "slots_required" };
  const ids = [...new Set(input.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim()))];
  if (ids.length === 0) return { error: "slots_required" };
  if (ids.length > CART_MAX_ITEMS) return { error: "cart_too_large" };
  return { slotIds: ids };
}

/**
 * Validate the server-read rows against the requested ids. Returns the FIRST refusal
 * (with every offending id for that refusal) or null when the cart is bookable.
 *
 * Rules (audit §6.2 / §8 / §9):
 *  - every requested id must exist as a future slot        → slot_unavailable
 *  - every slot public (is_public + tier === 'public')     → slot_not_bookable
 *  - no split-payment sessions in v1                       → split_not_supported
 *  - no cyclus session without allow_single_booking        → single_booking_not_allowed
 *  - one recipient org: single trainer AND single academy  → mixed_recipient
 *    (charge-org == confirm-org, invariant #6; null academy is its own bucket)
 */
export function validateCartSlots(requestedIds: string[], slots: CartSlotRow[], now = new Date()): CartRefusal | null {
  const byId = new Map(slots.map((s) => [s.id, s]));
  const missing = requestedIds.filter((id) => !byId.has(id));
  if (missing.length > 0) return { error: "slot_unavailable", slotIds: missing };

  const hidden = slots.filter((s) => {
    if (s.is_public !== true) return true;
    const tier = resolveSlotTier({
      priorityWindowEndsAt: s.priority_window_ends_at,
      hasPendingClaim: true,
      memberWindowEndsAt: s.member_window_ends_at,
      publicReleaseStatus: s.public_release_status,
      now,
    });
    return tier !== "public";
  });
  if (hidden.length > 0) return { error: "slot_not_bookable", slotIds: hidden.map((s) => s.id) };

  const split = slots.filter((s) => s.split_payment === true);
  if (split.length > 0) return { error: "split_not_supported", slotIds: split.map((s) => s.id) };

  const cyclusLocked = slots.filter((s) => s.cyclus_id != null && s.allow_single_booking !== true);
  if (cyclusLocked.length > 0) return { error: "single_booking_not_allowed", slotIds: cyclusLocked.map((s) => s.id) };

  const trainerId = slots[0]?.trainer_id ?? null;
  if (!trainerId) return { error: "no_mollie_account" };
  const academyId = slots[0]?.academy_profile_id ?? null;
  const mixed = slots.filter((s) => s.trainer_id !== trainerId || (s.academy_profile_id ?? null) !== academyId);
  if (mixed.length > 0) return { error: "mixed_recipient", slotIds: mixed.map((s) => s.id) };

  return null;
}

/**
 * Server-authoritative per-item pricing, in REQUESTED order (amounts must line up with
 * the slot_ids array handed to the RPC). Each item = the single-slot booking price
 * (per-seat when allow_single_booking && max_participants>1, else the whole session)
 * plus that slot's extra costs — identical to create-guest-slot-payment, so a cart of
 * one prices exactly like the existing single-slot flow. Cent-rounded per item.
 */
export function priceCartItems(
  requestedIds: string[],
  slots: CartSlotRow[],
  hourlyRate: number | null,
): { itemAmounts: number[]; total: number } {
  const byId = new Map(slots.map((s) => [s.id, s]));
  const itemAmounts = requestedIds.map((id) => {
    const slot = byId.get(id);
    if (!slot) return 0;
    const raw = computeSingleSlotPaymentAmount(slot as unknown as SlotPricingInput, hourlyRate, 1) +
      sumSlotExtraCosts(slot.extra_costs);
    return Math.round(raw * 100) / 100;
  });
  const total = Math.round(itemAmounts.reduce((s, a) => s + a, 0) * 100) / 100;
  return { itemAmounts, total };
}

/**
 * Map a refusal raised INSIDE book_guest_cart_for_payment back onto the cart error
 * contract. The RPC stamps the offending slot id in DETAIL (PostgREST surfaces it as
 * `details`); pre-RPC validation normally catches these, so this is the concurrent-
 * change path (a slot filled/hidden between read and lock).
 */
export function mapCartRpcError(rpcError: { message?: string | null; details?: string | null }): CartRefusal | null {
  const message = rpcError.message ?? "";
  const code = ["slot_full", "slot_not_public", "split_not_supported", "single_booking_not_allowed", "slot_unavailable", "invalid_input"]
    .find((c) => message.includes(c));
  if (!code) return null;
  const detail = (rpcError.details ?? "").trim();
  const slotIds = /^[0-9a-f-]{36}$/i.test(detail) ? [detail] : undefined;
  // A slot hidden between read and lock is the same guest-facing situation as one that
  // filled up: the item went stale. Keep the public vocabulary small.
  if (code === "slot_not_public") return { error: "slot_unavailable", slotIds };
  return { error: code, slotIds };
}
