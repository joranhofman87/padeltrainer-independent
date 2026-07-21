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
  /** Whole-slot selling: a cyclus session bookable individually as the ENTIRE slot at full price. */
  whole_slot_booking: boolean | null;
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
 *  - ONE PAYMENT RECIPIENT: academy-stamped slots route to the ACADEMY's Mollie
 *    (any of its trainers may mix in one cart); slots without an academy route to the
 *    trainer's OWN account (single trainer only). Mixing recipients → mixed_recipient
 *    (charge-org == confirm-org, invariant #6). Mirrors resolveSlotRecipient exactly.
 */
export function cartRecipientKey(slot: Pick<CartSlotRow, 'trainer_id' | 'academy_profile_id'>): string {
  return slot.academy_profile_id ? `academy:${slot.academy_profile_id}` : `trainer:${slot.trainer_id ?? ''}`;
}

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

  // A cyclus session is cartable per-seat (allow_single_booking) OR as a whole slot at full
  // price (whole_slot_booking — split slots were already refused above, so the whole-slot
  // unlock can never touch a per-seat split session).
  const cyclusLocked = slots.filter(
    (s) => s.cyclus_id != null && s.allow_single_booking !== true && s.whole_slot_booking !== true,
  );
  if (cyclusLocked.length > 0) return { error: "single_booking_not_allowed", slotIds: cyclusLocked.map((s) => s.id) };

  // Payment routing needs a trainer on every slot (the recipient resolver's membership
  // check for academy slots, the account owner for trainer-own slots).
  const orphaned = slots.filter((s) => !s.trainer_id);
  if (orphaned.length > 0) return { error: "no_mollie_account" };
  const firstKey = cartRecipientKey(slots[0]);
  const mixed = slots.filter((s) => cartRecipientKey(s) !== firstKey);
  if (mixed.length > 0) return { error: "mixed_recipient", slotIds: mixed.map((s) => s.id) };

  return null;
}

/**
 * Server-authoritative per-item pricing, in REQUESTED order (amounts must line up with
 * the slot_ids array handed to the RPC). Each item = the single-slot booking price
 * (per-seat when allow_single_booking && max_participants>1, else the whole session)
 * plus that slot's extra costs — identical to create-guest-slot-payment, so a cart of
 * one prices exactly like the existing single-slot flow. Cent-rounded per item.
 *
 * `hourlyRateByTrainer` maps trainer_id → hourly_rate: an academy cart may mix that
 * academy's trainers, and the hourly fallback (used when a slot has no explicit
 * price_per_session) is a PER-TRAINER rate — a single shared rate would misprice the
 * other trainers' unpriced slots.
 */
export function priceCartItems(
  requestedIds: string[],
  slots: CartSlotRow[],
  hourlyRateByTrainer: Record<string, number | null>,
): { itemAmounts: number[]; total: number } {
  const byId = new Map(slots.map((s) => [s.id, s]));
  const itemAmounts = requestedIds.map((id) => {
    const slot = byId.get(id);
    if (!slot) return 0;
    const hourlyRate = slot.trainer_id ? (hourlyRateByTrainer[slot.trainer_id] ?? null) : null;
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
  const code = [
    "slot_full", "slot_not_public", "split_not_supported", "single_booking_not_allowed",
    "slot_unavailable", "invalid_input",
    // The booking cutoff. Unlike the others this has NO pre-RPC counterpart — the mutation
    // boundary is its only enforcement point — so this mapping is the ordinary path, not a race.
    "booking_cutoff",
  ].find((c) => message.includes(c));
  if (!code) return null;
  const detail = (rpcError.details ?? "").trim();
  const slotIds = /^[0-9a-f-]{36}$/i.test(detail) ? [detail] : undefined;
  // A slot hidden between read and lock is the same guest-facing situation as one that
  // filled up: the item went stale. Keep the public vocabulary small.
  if (code === "slot_not_public") return { error: "slot_unavailable", slotIds };
  return { error: code, slotIds };
}
