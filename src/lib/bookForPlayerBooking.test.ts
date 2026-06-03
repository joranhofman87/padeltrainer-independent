import { describe, it, expect } from "vitest";
import {
  buildSingleSlotAddPlayerBookings,
  buildCyclusSlotAddPlayerBookings,
} from "@/lib/bookForPlayerBooking";

describe("buildSingleSlotAddPlayerBookings", () => {
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

  it("split payment divides session price across participants", () => {
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
