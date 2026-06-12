import { describe, it, expect } from "vitest";
import {
  calculateSlotBookingPricing,
  countActiveBookings,
  normalizeSessionPrice,
  canRebalanceBooking,
  usesConfiguredSlotSessionPrice,
  getRebalanceBookingIds,
  buildGuestBookingInsertRow,
  applyFirstPayerDiscount,
  resolveSlotSessionPrice,
  calculateAddPlayerPricingPreview,
} from "@/lib/bookingPricing";
import { buildSingleSlotAddPlayerBookings } from "@/lib/bookForPlayerBooking";

describe("normalizeSessionPrice", () => {
  it("returns 0 for null/undefined", () => {
    expect(normalizeSessionPrice(null)).toBe(0);
    expect(normalizeSessionPrice(undefined)).toBe(0);
  });

  it("returns configured price", () => {
    expect(normalizeSessionPrice(80)).toBe(80);
  });
});

describe("countActiveBookings", () => {
  it("counts confirmed and pending only", () => {
    expect(
      countActiveBookings([
        { status: "confirmed" },
        { status: "pending" },
        { status: "cancelled" },
      ]),
    ).toBe(2);
  });
});

describe("calculateSlotBookingPricing — split payment", () => {
  it("1 player total → 80 each", () => {
    const r = calculateSlotBookingPricing({
      sessionPrice: 80,
      splitPayment: true,
      existingActiveBookingCount: 0,
      newPlayerCount: 1,
    });
    expect(r.perPlayerAmount).toBe(80);
    expect(r.newPlayerAmounts).toEqual([80]);
    expect(r.shouldRebalanceExisting).toBe(false);
  });

  it("2 players total → 40 each", () => {
    const r = calculateSlotBookingPricing({
      sessionPrice: 80,
      splitPayment: true,
      existingActiveBookingCount: 1,
      newPlayerCount: 1,
    });
    expect(r.perPlayerAmount).toBe(40);
    expect(r.newPlayerAmounts).toEqual([40]);
    expect(r.existingBookingsNewAmount).toBe(40);
    expect(r.shouldRebalanceExisting).toBe(true);
  });

  it("4 players total → 20 each", () => {
    const r = calculateSlotBookingPricing({
      sessionPrice: 80,
      splitPayment: true,
      existingActiveBookingCount: 2,
      newPlayerCount: 2,
    });
    expect(r.perPlayerAmount).toBe(20);
    expect(r.newPlayerAmounts).toEqual([20, 20]);
    expect(r.existingBookingsNewAmount).toBe(20);
  });

  it("adding 2nd player rebalances existing from 80 to 40", () => {
    const before = calculateSlotBookingPricing({
      sessionPrice: 80,
      splitPayment: true,
      existingActiveBookingCount: 0,
      newPlayerCount: 1,
    });
    expect(before.newPlayerAmounts).toEqual([80]);

    const after = calculateSlotBookingPricing({
      sessionPrice: 80,
      splitPayment: true,
      existingActiveBookingCount: 1,
      newPlayerCount: 1,
    });
    expect(after.existingBookingsNewAmount).toBe(40);
    expect(after.newPlayerAmounts).toEqual([40]);
  });
});

describe("calculateSlotBookingPricing — non-split", () => {
  it("first player on empty slot → 80", () => {
    const r = calculateSlotBookingPricing({
      sessionPrice: 80,
      splitPayment: false,
      existingActiveBookingCount: 0,
      newPlayerCount: 1,
    });
    expect(r.newPlayerAmounts).toEqual([80]);
  });

  it("adding second when one exists → new player 0", () => {
    const r = calculateSlotBookingPricing({
      sessionPrice: 80,
      splitPayment: false,
      existingActiveBookingCount: 1,
      newPlayerCount: 1,
    });
    expect(r.newPlayerAmounts).toEqual([0]);
    expect(r.shouldRebalanceExisting).toBe(false);
  });

  it("adding two players to empty slot → first 80, second 0", () => {
    const r = calculateSlotBookingPricing({
      sessionPrice: 80,
      splitPayment: false,
      existingActiveBookingCount: 0,
      newPlayerCount: 2,
    });
    expect(r.newPlayerAmounts).toEqual([80, 0]);
  });
});

describe("canRebalanceBooking", () => {
  it("skips paid and paid_externally", () => {
    expect(canRebalanceBooking({ paymentStatus: "paid" })).toBe(false);
    expect(canRebalanceBooking({ paymentStatus: "pending", paidExternally: true })).toBe(
      false,
    );
    expect(canRebalanceBooking({ paymentStatus: "pending", paidExternally: false })).toBe(
      true,
    );
  });
});

describe("usesConfiguredSlotSessionPrice", () => {
  it("is true when price_per_session is set", () => {
    expect(usesConfiguredSlotSessionPrice(80)).toBe(true);
    expect(usesConfiguredSlotSessionPrice(null)).toBe(false);
  });
});

describe("getRebalanceBookingIds", () => {
  it("returns only unpaid, non-external bookings", () => {
    expect(
      getRebalanceBookingIds([
        { bookingId: "a", paymentStatus: "pending" },
        { bookingId: "b", paymentStatus: "paid" },
        { bookingId: "c", paymentStatus: "pending", paidExternally: true },
      ]),
    ).toEqual(["a"]);
  });
});

describe("buildGuestBookingInsertRow", () => {
  it("uses split per-player amount on insert", () => {
    const pricing = calculateSlotBookingPricing({
      sessionPrice: 80,
      splitPayment: true,
      existingActiveBookingCount: 1,
      newPlayerCount: 1,
    });
    const row = buildGuestBookingInsertRow({
      slotId: "slot-1",
      guestPlayerId: "guest-2",
      paymentAmount: pricing.newPlayerAmounts[0],
      sessionPrice: pricing.sessionPrice,
      notes: null,
    });
    expect(row.payment_amount).toBe(40);
    expect(row.original_amount).toBe(80);
  });

  it("uses 0 for non-split companion player", () => {
    const pricing = calculateSlotBookingPricing({
      sessionPrice: 80,
      splitPayment: false,
      existingActiveBookingCount: 1,
      newPlayerCount: 1,
    });
    const row = buildGuestBookingInsertRow({
      slotId: "slot-1",
      guestPlayerId: "guest-2",
      paymentAmount: pricing.newPlayerAmounts[0],
      sessionPrice: pricing.sessionPrice,
      notes: null,
    });
    expect(row.payment_amount).toBe(0);
  });
});

describe("resolveSlotSessionPrice", () => {
  it("prefers the configured slot price over the hourly rate", () => {
    expect(resolveSlotSessionPrice(95, 50, 60)).toBe(95);
  });

  it("falls back to hourly rate × duration when unset", () => {
    expect(resolveSlotSessionPrice(null, 50, 90)).toBe(75);
    expect(resolveSlotSessionPrice(0, 50, 60)).toBe(50);
  });
});

describe("calculateAddPlayerPricingPreview — dialog summary matches booking", () => {
  it("single player, single slot → full session price", () => {
    const p = calculateAddPlayerPricingPreview({
      slots: [{ sessionPrice: 80, existingActiveBookingCount: 0 }],
      splitPayment: false,
      newPlayerCount: 1,
      discountType: "percentage",
      discountValue: 0,
    });
    expect(p.subtotal).toBe(80);
    expect(p.total).toBe(80);
    expect(p.perPlayerTotals).toEqual([80]);
    expect(p.perPlayerSessionAmount).toBe(80);
  });

  it("multi-player split charges the slot price ONCE and splits it", () => {
    const p = calculateAddPlayerPricingPreview({
      slots: [{ sessionPrice: 80, existingActiveBookingCount: 0 }],
      splitPayment: true,
      newPlayerCount: 2,
      discountType: "percentage",
      discountValue: 0,
    });
    // NOT 160 — the old summary multiplied the price by player count.
    expect(p.subtotal).toBe(80);
    expect(p.perPlayerTotals).toEqual([40, 40]);
    expect(p.perPlayerSessionAmount).toBe(40);
  });

  it("split with existing players quotes the booking-time share", () => {
    const p = calculateAddPlayerPricingPreview({
      slots: [{ sessionPrice: 80, existingActiveBookingCount: 2 }],
      splitPayment: true,
      newPlayerCount: 1,
      discountType: "percentage",
      discountValue: 0,
    });
    expect(p.subtotal).toBe(26.67);
    expect(p.perPlayerTotals).toEqual([26.67]);
  });

  it("non-split multi-player puts the full price on the payer only", () => {
    const p = calculateAddPlayerPricingPreview({
      slots: [{ sessionPrice: 80, existingActiveBookingCount: 0 }],
      splitPayment: false,
      newPlayerCount: 3,
      payerIndex: 1,
      discountType: "percentage",
      discountValue: 0,
    });
    expect(p.subtotal).toBe(80);
    expect(p.perPlayerTotals).toEqual([0, 80, 0]);
    expect(p.perPlayerSessionAmount).toBeNull();
  });

  it("non-split companion joining an existing payer owes nothing", () => {
    const p = calculateAddPlayerPricingPreview({
      slots: [{ sessionPrice: 80, existingActiveBookingCount: 1 }],
      splitPayment: false,
      newPlayerCount: 1,
      discountType: "percentage",
      discountValue: 0,
    });
    expect(p.subtotal).toBe(0);
    expect(p.total).toBe(0);
  });

  it("percentage discount is a percentage of the REAL subtotal", () => {
    const p = calculateAddPlayerPricingPreview({
      slots: [{ sessionPrice: 80, existingActiveBookingCount: 0 }],
      splitPayment: true,
      newPlayerCount: 2,
      discountType: "percentage",
      discountValue: 10,
    });
    // 10% of 80 = €8 — not €16 (10% of the old inflated 160) and not "10€".
    expect(p.discountAmount).toBe(8);
    expect(p.total).toBe(72);
    expect(p.perPlayerTotals).toEqual([32, 40]);
  });

  it("absolute discount comes off the payer's row", () => {
    const p = calculateAddPlayerPricingPreview({
      slots: [{ sessionPrice: 80, existingActiveBookingCount: 0 }],
      splitPayment: false,
      newPlayerCount: 1,
      discountType: "fixed",
      discountValue: 10,
    });
    expect(p.discountAmount).toBe(10);
    expect(p.total).toBe(70);
  });

  it("cyclus: discount clamps to what the payer's FIRST booking can absorb", () => {
    const p = calculateAddPlayerPricingPreview({
      slots: [
        { sessionPrice: 80, existingActiveBookingCount: 0 },
        { sessionPrice: 80, existingActiveBookingCount: 0 },
        { sessionPrice: 80, existingActiveBookingCount: 0 },
      ],
      splitPayment: true,
      newPlayerCount: 2,
      discountType: "fixed",
      discountValue: 100,
    });
    // Payer's first-slot share is €40 — booking can never grant more.
    expect(p.subtotal).toBe(240);
    expect(p.discountAmount).toBe(40);
    expect(p.total).toBe(200);
    expect(p.perPlayerTotals).toEqual([80, 120]);
  });

  it("uses the configured slot price, not the hourly-derived one", () => {
    const sessionPrice = resolveSlotSessionPrice(95, 50, 60);
    const p = calculateAddPlayerPricingPreview({
      slots: [{ sessionPrice, existingActiveBookingCount: 0 }],
      splitPayment: false,
      newPlayerCount: 1,
      discountType: "fixed",
      discountValue: 0,
    });
    expect(p.total).toBe(95);
  });

  it("matches buildSingleSlotAddPlayerBookings row-for-row (split + discount)", () => {
    const preview = calculateAddPlayerPricingPreview({
      slots: [{ sessionPrice: 80, existingActiveBookingCount: 1 }],
      splitPayment: true,
      newPlayerCount: 2,
      discountType: "percentage",
      discountValue: 10,
    });
    const rows = buildSingleSlotAddPlayerBookings({
      slotId: "slot-1",
      sessionPrice: 80,
      splitPayment: true,
      existingActiveBookingCount: 1,
      guestPlayerIds: ["g1", "g2"],
      notes: null,
      firstPlayerDiscount: preview.firstPlayerDiscount,
    });
    expect(rows.map((r) => r.payment_amount)).toEqual(preview.perPlayerTotals);
    expect(rows.reduce((sum, r) => sum + r.payment_amount, 0)).toBeCloseTo(
      preview.total,
      2,
    );
  });

  it("matches buildSingleSlotAddPlayerBookings for non-split payer selection", () => {
    const preview = calculateAddPlayerPricingPreview({
      slots: [{ sessionPrice: 80, existingActiveBookingCount: 0 }],
      splitPayment: false,
      newPlayerCount: 2,
      payerIndex: 1,
      discountType: "fixed",
      discountValue: 10,
    });
    const rows = buildSingleSlotAddPlayerBookings({
      slotId: "slot-1",
      sessionPrice: 80,
      splitPayment: false,
      existingActiveBookingCount: 0,
      guestPlayerIds: ["g1", "g2"],
      payerGuestPlayerId: "g2",
      notes: null,
      firstPlayerDiscount: preview.firstPlayerDiscount,
    });
    expect(rows.map((r) => r.payment_amount)).toEqual(preview.perPlayerTotals);
    expect(preview.total).toBe(70);
  });
});

describe("applyFirstPayerDiscount — discount targets the payer, not index 0", () => {
  it("applies the discount whenever discountAmount > 0, regardless of playerIndex", () => {
    // The payer is the 2nd selected player (index 1) — the caller passes the
    // discount on that row. The discount MUST still apply (M-03 regression).
    expect(applyFirstPayerDiscount({ playerIndex: 1, paymentAmount: 50, discountAmount: 10 })).toBe(40);
    expect(applyFirstPayerDiscount({ playerIndex: 0, paymentAmount: 50, discountAmount: 10 })).toBe(40);
  });
  it("leaves non-payer rows untouched (caller passes 0)", () => {
    expect(applyFirstPayerDiscount({ playerIndex: 2, paymentAmount: 50, discountAmount: 0 })).toBe(50);
  });
  it("never goes below zero", () => {
    expect(applyFirstPayerDiscount({ playerIndex: 1, paymentAmount: 8, discountAmount: 10 })).toBe(0);
  });
});
