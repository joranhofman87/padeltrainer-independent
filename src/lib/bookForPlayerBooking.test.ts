import { describe, it, expect } from "vitest";
import {
  buildSingleSlotAddPlayerBookings,
  buildCyclusSlotAddPlayerBookings,
} from "@/lib/bookForPlayerBooking";

describe("buildSingleSlotAddPlayerBookings", () => {
  it("non-split 3 players with chosen payer invoices only payer amount", () => {
    const rows = buildSingleSlotAddPlayerBookings({
      slotId: "slot-1",
      sessionPrice: 100,
      splitPayment: false,
      existingActiveBookingCount: 0,
      guestPlayerIds: ["g1", "g2", "g3"],
      payerGuestPlayerId: "g3",
      notes: null,
    });
    expect(rows.find((r) => r.guest_player_id === "g3")?.payment_amount).toBe(100);
    expect(rows.find((r) => r.guest_player_id === "g1")?.payment_amount).toBe(0);
    expect(rows.find((r) => r.guest_player_id === "g2")?.payment_amount).toBe(0);
  });

  it("non-split with existing payer charges companion €0", () => {
    const rows = buildSingleSlotAddPlayerBookings({
      slotId: "slot-1",
      sessionPrice: 80,
      splitPayment: false,
      existingActiveBookingCount: 1,
      guestPlayerIds: ["guest-new"],
      notes: null,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].payment_amount).toBe(0);
  });

  it("split payment divides session price across participants (legacy live-count, no capacity)", () => {
    const rows = buildSingleSlotAddPlayerBookings({
      slotId: "slot-1",
      sessionPrice: 80,
      splitPayment: true,
      existingActiveBookingCount: 1,
      guestPlayerIds: ["guest-new"],
      notes: null,
    });
    expect(rows[0].payment_amount).toBe(40);
  });

  it("split with a FROZEN capacity → slot/capacity, ignoring live headcount (audit Batch 2 c)", () => {
    // A player added to a split court of 4 pays €20 (80/4) whether they're the 1st or the 3rd —
    // matching the invoice/recalc/charge paths — not €40 (80/live-2) or the full €80.
    const lone = buildSingleSlotAddPlayerBookings({
      slotId: "slot-1",
      sessionPrice: 80,
      splitPayment: true,
      existingActiveBookingCount: 0,
      guestPlayerIds: ["guest-new"],
      notes: null,
      slotCapacity: 4,
    });
    expect(lone[0].payment_amount).toBe(20);

    const third = buildSingleSlotAddPlayerBookings({
      slotId: "slot-1",
      sessionPrice: 80,
      splitPayment: true,
      existingActiveBookingCount: 2,
      guestPlayerIds: ["guest-new"],
      notes: null,
      slotCapacity: 4,
    });
    expect(third[0].payment_amount).toBe(20);
  });

  it("non-split empty slot: first player full price, second companion €0", () => {
    const rows = buildSingleSlotAddPlayerBookings({
      slotId: "slot-1",
      sessionPrice: 80,
      splitPayment: false,
      existingActiveBookingCount: 0,
      guestPlayerIds: ["g1", "g2"],
      notes: null,
    });
    expect(rows[0].payment_amount).toBe(80);
    expect(rows[1].payment_amount).toBe(0);
  });
});

describe("buildCyclusSlotAddPlayerBookings", () => {
  it("applies discount only on first slot first player", () => {
    const rows = buildCyclusSlotAddPlayerBookings({
      slotId: "slot-1",
      sessionPrice: 80,
      splitPayment: false,
      existingActiveBookingCount: 0,
      guestPlayerIds: ["g1"],
      notes: null,
      firstPlayerDiscount: 10,
      isFirstCyclusSlot: true,
    });
    expect(rows[0].payment_amount).toBe(70);
    expect(rows[0].discount_amount).toBe(10);
  });
});
