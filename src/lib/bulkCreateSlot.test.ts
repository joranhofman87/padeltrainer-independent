import { describe, it, expect } from "vitest";
import {
  buildDefaultBulkSlotOwnership,
  shouldInvokeNotifyFollowersOnBulkGenerate,
  shouldShowBulkBookingPartialFailureToast,
  shouldShowBulkPlayersAddedToast,
} from "@/lib/bulkCreateSlot";
import {
  expectsBulkGuestBookings,
  getBulkGenerateBookingOutcome,
} from "@/lib/academyCreateSlot";

describe("buildDefaultBulkSlotOwnership", () => {
  it("sets academyProfileId from academyId for academy create-cycle", () => {
    expect(buildDefaultBulkSlotOwnership("trainer-1", "academy-uuid")).toEqual({
      academyProfileId: "academy-uuid",
      trainerId: "trainer-1",
    });
  });

  it("leaves academyProfileId null in trainer-only mode", () => {
    expect(buildDefaultBulkSlotOwnership("trainer-1", undefined)).toEqual({
      academyProfileId: null,
      trainerId: "trainer-1",
    });
  });
});

describe("bulk generate booking toasts", () => {
  it("shows partial-success toast when booking insert fails", () => {
    const outcome = getBulkGenerateBookingOutcome({
      expectedEnrollment: true,
      totalBookingsCreated: 0,
      hadBookingInsertError: true,
    });
    expect(outcome).toBe("partial_failure");
    expect(shouldShowBulkBookingPartialFailureToast(outcome)).toBe(true);
    expect(shouldShowBulkPlayersAddedToast(outcome, 0)).toBe(false);
  });

  it("shows players-added toast when bookings succeed", () => {
    const outcome = getBulkGenerateBookingOutcome({
      expectedEnrollment: true,
      totalBookingsCreated: 8,
      hadBookingInsertError: false,
    });
    expect(outcome).toBe("success");
    expect(shouldShowBulkBookingPartialFailureToast(outcome)).toBe(false);
    expect(shouldShowBulkPlayersAddedToast(outcome, 8)).toBe(true);
  });

  it("shows neither partial nor players-added when no guests selected", () => {
    const bulkSlots = [{ addPlayers: true, selectedPlayers: [] as string[] }];
    expect(expectsBulkGuestBookings(bulkSlots)).toBe(false);
    const outcome = getBulkGenerateBookingOutcome({
      expectedEnrollment: false,
      totalBookingsCreated: 0,
      hadBookingInsertError: false,
    });
    expect(outcome).toBe("none");
    expect(shouldShowBulkBookingPartialFailureToast(outcome)).toBe(false);
    expect(shouldShowBulkPlayersAddedToast(outcome, 0)).toBe(false);
  });
});

describe("shouldInvokeNotifyFollowersOnBulkGenerate", () => {
  it("does not invoke notify-followers in academy mode", () => {
    expect(
      shouldInvokeNotifyFollowersOnBulkGenerate({ academyId: "academy-1" }),
    ).toBe(false);
  });

  it("invokes notify-followers for trainer self-service", () => {
    expect(shouldInvokeNotifyFollowersOnBulkGenerate({})).toBe(true);
    expect(
      shouldInvokeNotifyFollowersOnBulkGenerate({ academyId: null }),
    ).toBe(true);
  });

  it("does not invoke when there are no public slots", () => {
    expect(
      shouldInvokeNotifyFollowersOnBulkGenerate({
        hasPublicSlots: false,
        academyId: undefined,
      }),
    ).toBe(false);
  });
});
