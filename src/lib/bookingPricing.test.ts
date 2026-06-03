import { describe, it, expect } from "vitest";
import {
  calculateSlotBookingPricing,
  countActiveBookings,
  normalizeSessionPrice,
  canRebalanceBooking,
  usesConfiguredSlotSessionPrice,
  getRebalanceBookingIds,
  buildGuestBookingInsertRow,
} from "@/lib/bookingPricing";

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
