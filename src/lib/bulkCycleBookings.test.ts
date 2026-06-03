import { describe, it, expect } from "vitest";
import { buildBulkCycleBookings } from "@/lib/bulkCycleBookings";

describe("buildBulkCycleBookings", () => {
  it("non-split 3 players on 2 slots → one payer full price per slot, others zero", () => {
    const rows = buildBulkCycleBookings({
      slotIds: ["s1", "s2"],
      selectedPlayers: ["p1", "p2", "p3"],
      payerGuestPlayerId: "p2",
      sessionPrice: 100,
      splitPayment: false,
      markAsPaid: false,
    });

    expect(rows).toHaveLength(6);
    const payerRows = rows.filter((r) => r.guest_player_id === "p2");
    const companionRows = rows.filter((r) => r.guest_player_id !== "p2");
    expect(payerRows.every((r) => r.payment_amount === 100)).toBe(true);
    expect(companionRows.every((r) => r.payment_amount === 0)).toBe(true);
  });

  it("split 3 players → equal payment per slot", () => {
    const rows = buildBulkCycleBookings({
      slotIds: ["s1"],
      selectedPlayers: ["p1", "p2", "p3"],
      payerGuestPlayerId: null,
      sessionPrice: 100,
      splitPayment: true,
      markAsPaid: false,
    });

    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.payment_amount === 33.33)).toBe(true);
  });

  it("uses first player as payer when payer not set (non-split)", () => {
    const rows = buildBulkCycleBookings({
      slotIds: ["s1"],
      selectedPlayers: ["p1", "p2"],
      payerGuestPlayerId: null,
      sessionPrice: 100,
      splitPayment: false,
      markAsPaid: false,
    });

    expect(rows.find((r) => r.guest_player_id === "p1")?.payment_amount).toBe(100);
    expect(rows.find((r) => r.guest_player_id === "p2")?.payment_amount).toBe(0);
  });
});
