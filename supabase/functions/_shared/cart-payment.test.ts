// Deno tests for the cart validation/pricing core (runs in the CI edge-test gate).
// These are the audit's blocking edge-level tests (MULTI_SESSION_CART_BOOKING_AUDIT.md §16):
// server-pricing parity, the single-recipient-org guard, split exclusion, N_MAX rejection.
import { assertEquals, assertNotEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import {
  CART_MAX_ITEMS,
  type CartSlotRow,
  mapCartRpcError,
  normalizeCartSlotIds,
  priceCartItems,
  validateCartSlots,
} from "./cart-payment.ts";

const T1 = "trainer-1";
const A1 = "academy-1";

let seq = 0;
function slot(overrides: Partial<CartSlotRow> = {}): CartSlotRow {
  seq += 1;
  return {
    id: `slot-${seq}`,
    trainer_id: T1,
    academy_profile_id: A1,
    cyclus_id: null,
    price_per_session: 30,
    start_time: "2027-01-01T10:00:00Z",
    end_time: "2027-01-01T11:00:00Z",
    max_participants: 1,
    allow_single_booking: true,
    whole_slot_booking: false,
    split_payment: false,
    extra_costs: null,
    is_public: true,
    priority_window_ends_at: null,
    member_window_ends_at: null,
    public_release_status: null,
    ...overrides,
  };
}

// ---------- normalizeCartSlotIds ----------

Deno.test("normalize: dedupes a double-tapped slot (no double charge)", () => {
  const r = normalizeCartSlotIds(["a", "b", "a", " b "]);
  assertEquals("slotIds" in r ? r.slotIds : null, ["a", "b"]);
});

Deno.test("normalize: rejects an oversized cart with cart_too_large (never truncates)", () => {
  const ids = Array.from({ length: CART_MAX_ITEMS + 1 }, (_, i) => `slot-${i}`);
  assertEquals(normalizeCartSlotIds(ids), { error: "cart_too_large" });
  // exactly at the cap is fine
  const ok = normalizeCartSlotIds(ids.slice(0, CART_MAX_ITEMS));
  assertEquals("slotIds" in ok && ok.slotIds.length, CART_MAX_ITEMS);
});

Deno.test("normalize: rejects junk input", () => {
  assertEquals(normalizeCartSlotIds(undefined), { error: "slots_required" });
  assertEquals(normalizeCartSlotIds([]), { error: "slots_required" });
  assertEquals(normalizeCartSlotIds([42, null, "  "]), { error: "slots_required" });
});

// ---------- validateCartSlots ----------

Deno.test("validate: a bookable single-org cart passes", () => {
  const s1 = slot(), s2 = slot();
  assertEquals(validateCartSlots([s1.id, s2.id], [s1, s2]), null);
});

Deno.test("validate: missing ids -> slot_unavailable naming exactly the stale items", () => {
  const s1 = slot();
  const r = validateCartSlots([s1.id, "gone-1", "gone-2"], [s1]);
  assertEquals(r, { error: "slot_unavailable", slotIds: ["gone-1", "gone-2"] });
});

Deno.test("validate: a non-public slot -> slot_not_bookable (is_public is the primary flag)", () => {
  const pub = slot(), hidden = slot({ is_public: false });
  const r = validateCartSlots([pub.id, hidden.id], [pub, hidden]);
  assertEquals(r, { error: "slot_not_bookable", slotIds: [hidden.id] });
});

Deno.test("validate: a priority/member-tier slot -> slot_not_bookable (no window leak)", () => {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const tiered = slot({ priority_window_ends_at: future });
  const r = validateCartSlots([tiered.id], [tiered]);
  assertEquals(r, { error: "slot_not_bookable", slotIds: [tiered.id] });
});

Deno.test("validate: split-payment sessions are excluded from cart v1", () => {
  const ok = slot(), sp = slot({ split_payment: true });
  const r = validateCartSlots([ok.id, sp.id], [ok, sp]);
  assertEquals(r, { error: "split_not_supported", slotIds: [sp.id] });
});

Deno.test("validate: a cyclus session without allow_single_booking must go whole-cyclus", () => {
  const locked = slot({ cyclus_id: "cyc-1", allow_single_booking: false });
  const r = validateCartSlots([locked.id], [locked]);
  assertEquals(r, { error: "single_booking_not_allowed", slotIds: [locked.id] });
});

Deno.test("validate: a cyclus session WITH allow_single_booking is cartable", () => {
  const open = slot({ cyclus_id: "cyc-1", allow_single_booking: true, max_participants: 4 });
  assertEquals(validateCartSlots([open.id], [open]), null);
});

Deno.test("validate: a WHOLE-SLOT cyclus session (allow_single=false, whole_slot=true) is cartable", () => {
  const whole = slot({ cyclus_id: "cyc-1", allow_single_booking: false, whole_slot_booking: true, max_participants: 4 });
  assertEquals(validateCartSlots([whole.id], [whole]), null);
});

Deno.test("validate: split beats whole-slot — a split+whole_slot session is refused as split (#352 stays closed)", () => {
  const bad = slot({ cyclus_id: "cyc-1", allow_single_booking: false, whole_slot_booking: true, split_payment: true, max_participants: 4 });
  const r = validateCartSlots([bad.id], [bad]);
  assertEquals(r, { error: "split_not_supported", slotIds: [bad.id] });
});

Deno.test("pricing: a whole-slot cyclus session charges the FULL session price (never /max_participants)", () => {
  const whole = slot({ cyclus_id: "cyc-1", allow_single_booking: false, whole_slot_booking: true, max_participants: 4, price_per_session: 76.5 });
  assertEquals(priceCartItems([whole.id], [whole], {}).total, 76.5);
});

Deno.test("validate: different trainers of ONE academy may mix (the money routes to the academy)", () => {
  const a = slot(), b = slot({ trainer_id: "trainer-2" }); // both academy-1
  assertEquals(validateCartSlots([a.id, b.id], [a, b]), null);
});

Deno.test("validate: trainer-OWN slots (no academy) allow only that single trainer", () => {
  const a = slot({ academy_profile_id: null }), b = slot({ trainer_id: "trainer-2", academy_profile_id: null });
  const r = validateCartSlots([a.id, b.id], [a, b]);
  assertEquals(r, { error: "mixed_recipient", slotIds: [b.id] });
});

Deno.test("validate: mixed academies -> mixed_recipient, even under ONE trainer", () => {
  const a = slot(), b = slot({ academy_profile_id: "academy-2" });
  const r = validateCartSlots([a.id, b.id], [a, b]);
  assertEquals(r, { error: "mixed_recipient", slotIds: [b.id] });
});

Deno.test("validate: null academy is its OWN bucket — trainer-own + academy slots don't mix", () => {
  const own = slot({ academy_profile_id: null }), acad = slot();
  const r = validateCartSlots([own.id, acad.id], [own, acad]);
  assertEquals(r, { error: "mixed_recipient", slotIds: [acad.id] });
});

Deno.test("validate: an all-null-academy (trainer-own) cart is a valid single org", () => {
  const a = slot({ academy_profile_id: null }), b = slot({ academy_profile_id: null });
  assertEquals(validateCartSlots([a.id, b.id], [a, b]), null);
});

Deno.test("validate: a slot without a trainer cannot route payment -> no_mollie_account", () => {
  const orphan = slot({ trainer_id: null });
  assertEquals(validateCartSlots([orphan.id], [orphan]), { error: "no_mollie_account" });
});

// ---------- priceCartItems (server-pricing parity with create-guest-slot-payment) ----------

Deno.test("pricing: split_payment session charges price/max_participants + extras (paid individually)", () => {
  // split_payment && maxP>1 → one seat of N: 40/4 + 2.50 extra = 12.50
  const perSeat = slot({
    price_per_session: 40,
    max_participants: 4,
    allow_single_booking: true,
    split_payment: true,
    extra_costs: [{ description: "balls", price: 2.5 }],
  });
  const { itemAmounts, total } = priceCartItems([perSeat.id], [perSeat], {});
  assertEquals(itemAmounts, [12.5]);
  assertEquals(total, 12.5);
});

Deno.test("pricing: NON-split individually-bookable session charges the FULL price (paid at once) — F01", () => {
  // allow_single_booking=true but split_payment=false → "paid at once", full price, NOT ÷ capacity.
  // 40 + 2.50 extra = 42.50 (previously mis-divided to 12.50).
  const perSeat = slot({
    price_per_session: 40,
    max_participants: 4,
    allow_single_booking: true,
    split_payment: false,
    extra_costs: [{ description: "balls", price: 2.5 }],
  });
  const { itemAmounts, total } = priceCartItems([perSeat.id], [perSeat], {});
  assertEquals(itemAmounts, [42.5]);
  assertEquals(total, 42.5);
});

Deno.test("pricing: whole-slot item (allow_single_booking=false) charges the FULL session price", () => {
  const whole = slot({ price_per_session: 40, max_participants: 4, allow_single_booking: false });
  assertEquals(priceCartItems([whole.id], [whole], {}).total, 40);
});

Deno.test("pricing: falls back to hourly_rate x duration when price_per_session is absent", () => {
  const hourly = slot({ price_per_session: null }); // 60-minute slot
  assertEquals(priceCartItems([hourly.id], [hourly], { [T1]: 50 }).total, 50);
});

Deno.test("pricing: an academy cart uses EACH trainer's own hourly fallback rate", () => {
  const a = slot({ price_per_session: null }); // T1, 60 min
  const b = slot({ price_per_session: null, trainer_id: "trainer-2" }); // 60 min
  const { itemAmounts, total } = priceCartItems([a.id, b.id], [a, b], { [T1]: 50, "trainer-2": 80 });
  assertEquals(itemAmounts, [50, 80]);
  assertEquals(total, 130);
});

Deno.test("pricing: total is the exact sum, amounts aligned to REQUESTED order", () => {
  const a = slot({ price_per_session: 15 });
  const b = slot({ price_per_session: 12.5, extra_costs: [{ description: "hal", price: 1.25 }] });
  const { itemAmounts, total } = priceCartItems([b.id, a.id], [a, b], {});
  assertEquals(itemAmounts, [13.75, 15]);
  assertEquals(total, 28.75);
});

Deno.test("pricing: negative/junk extra costs are ignored (never a discount vector)", () => {
  const s = slot({ price_per_session: 20, extra_costs: [{ description: "x", price: -5 }, { price: undefined }] });
  assertEquals(priceCartItems([s.id], [s], {}).total, 20);
});

Deno.test("pricing: fractional-cent hourly prices are cent-rounded per item", () => {
  // 50/hr over 40 min = 33.333… → 33.33
  const s = slot({ price_per_session: null, end_time: "2027-01-01T10:40:00Z" });
  const { total } = priceCartItems([s.id], [s], { [T1]: 50 });
  assertEquals(total, 33.33);
  assertNotEquals(total, 33.333333333333336);
});

// ---------- mapCartRpcError (the concurrent-change path) ----------

Deno.test("rpc-error map: slot_full carries the offending id from DETAIL", () => {
  const id = "9f8e7d6c-5b4a-3210-fedc-ba9876543210";
  assertEquals(mapCartRpcError({ message: "slot_full", details: id }), { error: "slot_full", slotIds: [id] });
});

Deno.test("rpc-error map: slot_not_public collapses to slot_unavailable for the guest", () => {
  const id = "9f8e7d6c-5b4a-3210-fedc-ba9876543210";
  assertEquals(mapCartRpcError({ message: "slot_not_public", details: id }), { error: "slot_unavailable", slotIds: [id] });
});

Deno.test("rpc-error map: booking_cutoff reaches the guest as its own refusal, not a generic failure", () => {
  // The edge pre-check normally refuses first, so this is the race / degraded-pre-check path.
  // Unmapped it would surface as a 500 for a rule we have clear copy for.
  const id = "9f8e7d6c-5b4a-3210-fedc-ba9876543210";
  assertEquals(mapCartRpcError({ message: "booking_cutoff", details: id }), { error: "booking_cutoff", slotIds: [id] });
});

Deno.test("rpc-error map: junk detail is dropped, unknown messages pass through as null", () => {
  assertEquals(mapCartRpcError({ message: "slot_full", details: "P0001 not-a-uuid" }), { error: "slot_full", slotIds: undefined });
  assertEquals(mapCartRpcError({ message: "deadlock detected", details: null }), null);
});
