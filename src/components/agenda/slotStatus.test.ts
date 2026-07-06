// Pins the canonical slot-status rules and the EXACT class strings each agenda
// card rendered before the extraction (CalendarSlotCard = interactive variant,
// DayViewSlotCard = static variant). If one of these snapshots fails, the
// agenda cards no longer render byte-identically to the pre-extraction copies.
import { describe, it, expect } from "vitest";
import type { SlotWithBookings } from "@/lib/slotTypes";
import {
  getSlotStatus,
  slotStatusCardClasses,
  slotStatusTextClasses,
  type SlotStatus,
} from "./slotStatus";

function makeSlot(overrides: Partial<SlotWithBookings> = {}): SlotWithBookings {
  return {
    id: "slot-1",
    start_time: "2026-07-04T09:00:00Z",
    end_time: "2026-07-04T10:00:00Z",
    max_participants: 4,
    price: null,
    active_bookings: 0,
    pending_bookings: 0,
    is_past: false,
    is_public: true,
    cyclus_id: null,
    cyclus_name: null,
    booked_players: [],
    location_name: null,
    ...overrides,
  };
}

describe("getSlotStatus", () => {
  it("returns free when the slot is upcoming, public and has no active bookings", () => {
    expect(getSlotStatus(makeSlot())).toBe("free");
  });

  it("returns partial for 1-3 active bookings", () => {
    expect(getSlotStatus(makeSlot({ active_bookings: 1 }))).toBe("partial");
    expect(getSlotStatus(makeSlot({ active_bookings: 2 }))).toBe("partial");
    expect(getSlotStatus(makeSlot({ active_bookings: 3 }))).toBe("partial");
  });

  it("returns full at 4 or more active bookings", () => {
    expect(getSlotStatus(makeSlot({ active_bookings: 4 }))).toBe("full");
    expect(getSlotStatus(makeSlot({ active_bookings: 5 }))).toBe("full");
  });

  it("follows the slot's real max_participants (trainer-audit fix, was a literal 4)", () => {
    // A 2-person slot with 2 booked IS full; an 8-person slot with 4 booked is NOT.
    expect(getSlotStatus(makeSlot({ max_participants: 2, active_bookings: 2 }))).toBe("full");
    expect(getSlotStatus(makeSlot({ max_participants: 8, active_bookings: 4 }))).toBe("partial");
  });

  it("returns private (marked full) when not public, regardless of bookings", () => {
    expect(getSlotStatus(makeSlot({ is_public: false }))).toBe("private");
    expect(getSlotStatus(makeSlot({ is_public: false, active_bookings: 4 }))).toBe("private");
  });

  it("past wins over private and full", () => {
    expect(
      getSlotStatus(makeSlot({ is_past: true, is_public: false, active_bookings: 4 })),
    ).toBe("past");
  });

  it("pending bookings do not count toward the status", () => {
    expect(getSlotStatus(makeSlot({ pending_bookings: 4 }))).toBe("free");
  });
});

describe("slotStatusCardClasses", () => {
  it("interactive variant matches CalendarSlotCard's original statusColors byte-for-byte", () => {
    const expected: Record<SlotStatus, string> = {
      free: "bg-green-100 dark:bg-green-900/30 border-green-300 dark:border-green-700 hover:bg-green-200 dark:hover:bg-green-900/50",
      partial:
        "bg-orange-100 dark:bg-orange-900/30 border-orange-300 dark:border-orange-700 hover:bg-orange-200 dark:hover:bg-orange-900/50",
      full: "bg-blue-100 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700 hover:bg-blue-200 dark:hover:bg-blue-900/50",
      past: "bg-muted/30 border-muted opacity-50",
      private:
        "bg-purple-100 dark:bg-purple-900/30 border-purple-300 dark:border-purple-700 hover:bg-purple-200 dark:hover:bg-purple-900/50",
    };
    for (const status of Object.keys(expected) as SlotStatus[]) {
      expect(slotStatusCardClasses(status, { interactive: true })).toBe(expected[status]);
    }
  });

  it("static variant matches DayViewSlotCard's original statusColors byte-for-byte", () => {
    const expected: Record<SlotStatus, string> = {
      free: "bg-green-100 dark:bg-green-900/30 border-green-300 dark:border-green-700",
      partial: "bg-orange-100 dark:bg-orange-900/30 border-orange-300 dark:border-orange-700",
      full: "bg-blue-100 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700",
      past: "bg-muted/30 border-muted opacity-60",
      private: "bg-purple-100 dark:bg-purple-900/30 border-purple-300 dark:border-purple-700",
    };
    for (const status of Object.keys(expected) as SlotStatus[]) {
      expect(slotStatusCardClasses(status)).toBe(expected[status]);
      // omitted options object behaves the same as interactive: false
      expect(slotStatusCardClasses(status, { interactive: false })).toBe(expected[status]);
    }
  });

  it("preserves the pre-existing past-opacity drift between the two cards (owner may unify)", () => {
    expect(slotStatusCardClasses("past", { interactive: true })).toContain("opacity-50");
    expect(slotStatusCardClasses("past")).toContain("opacity-60");
  });
});

describe("slotStatusTextClasses", () => {
  it("matches the original statusTextColors (identical in both cards) byte-for-byte", () => {
    const expected: Record<SlotStatus, string> = {
      free: "text-green-700 dark:text-green-300",
      partial: "text-orange-700 dark:text-orange-300",
      full: "text-blue-700 dark:text-blue-300",
      past: "text-muted-foreground",
      private: "text-purple-700 dark:text-purple-300",
    };
    for (const status of Object.keys(expected) as SlotStatus[]) {
      expect(slotStatusTextClasses(status)).toBe(expected[status]);
    }
  });
});
