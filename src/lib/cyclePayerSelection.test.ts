import { describe, it, expect } from "vitest";
import {
  getDefaultPayerId,
  normalizePayerId,
  shouldShowPayerSelector,
  buildCyclePlayerPaymentAmounts,
  getChargeableBookingIds,
  groupChargeableBookingsByGuest,
} from "@/lib/cyclePayerSelection";

describe("normalizePayerId", () => {
  it("defaults to first selected player", () => {
    expect(normalizePayerId(["a", "b", "c"], null)).toBe("a");
  });

  it("keeps current payer when still selected", () => {
    expect(normalizePayerId(["a", "b", "c"], "b")).toBe("b");
  });

  it("resets to first when payer removed from selection", () => {
    expect(normalizePayerId(["a", "c"], "b")).toBe("a");
  });

  it("returns single player when only one selected", () => {
    expect(normalizePayerId(["x"], "y")).toBe("x");
  });
});

describe("shouldShowPayerSelector", () => {
  it("shows when non-split and multiple players", () => {
    expect(shouldShowPayerSelector(false, ["a", "b"])).toBe(true);
  });

  it("hides when split payment", () => {
    expect(shouldShowPayerSelector(true, ["a", "b"])).toBe(false);
  });

  it("hides for single player", () => {
    expect(shouldShowPayerSelector(false, ["a"])).toBe(false);
  });
});

describe("buildCyclePlayerPaymentAmounts", () => {
  it("non-split, 1 player → full price", () => {
    const amounts = buildCyclePlayerPaymentAmounts({
      selectedPlayerIds: ["p1"],
      payerGuestPlayerId: "p1",
      sessionPrice: 100,
      splitPayment: false,
    });
    expect(amounts.get("p1")).toBe(100);
  });

  it("non-split, 3 players → payer 100, others 0", () => {
    const amounts = buildCyclePlayerPaymentAmounts({
      selectedPlayerIds: ["p1", "p2", "p3"],
      payerGuestPlayerId: "p2",
      sessionPrice: 100,
      splitPayment: false,
    });
    expect(amounts.get("p1")).toBe(0);
    expect(amounts.get("p2")).toBe(100);
    expect(amounts.get("p3")).toBe(0);
  });

  it("split payment, 3 players → equal shares", () => {
    const amounts = buildCyclePlayerPaymentAmounts({
      selectedPlayerIds: ["p1", "p2", "p3"],
      payerGuestPlayerId: null,
      sessionPrice: 100,
      splitPayment: true,
    });
    expect(amounts.get("p1")).toBeCloseTo(33.33, 2);
    expect(amounts.get("p2")).toBeCloseTo(33.33, 2);
    expect(amounts.get("p3")).toBeCloseTo(33.33, 2);
  });
});

describe("getChargeableBookingIds", () => {
  it("excludes €0 bookings", () => {
    expect(
      getChargeableBookingIds([
        { id: "b1", guest_player_id: "p1", payment_amount: 100 },
        { id: "b2", guest_player_id: "p2", payment_amount: 0 },
      ]),
    ).toEqual(["b1"]);
  });
});

describe("groupChargeableBookingsByGuest", () => {
  it("only groups bookings with payment_amount > 0", () => {
    const map = groupChargeableBookingsByGuest([
      { id: "b1", guest_player_id: "p1", payment_amount: 50 },
      { id: "b2", guest_player_id: "p2", payment_amount: 0 },
      { id: "b3", guest_player_id: "p1", payment_amount: 50 },
    ]);
    expect(map.get("p1")).toEqual(["b1", "b3"]);
    expect(map.has("p2")).toBe(false);
  });
});

describe("getDefaultPayerId", () => {
  it("returns first id", () => {
    expect(getDefaultPayerId(["first", "second"])).toBe("first");
  });
});
