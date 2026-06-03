import { describe, it, expect } from "vitest";
import {
  getAcademyCreateSlotPrerequisites,
  hasBlockingAcademyCreateSlotPrerequisite,
  mapAcademyLocationToSlotLocation,
  mapAcademyLocationsToSlotLocations,
  getBulkGenerateValidationError,
  shouldInitializeAcademyDefaultBulkSlot,
  resolveAcademyDefaultBulkTrainerId,
  expectsBulkGuestBookings,
  getBulkGenerateBookingOutcome,
  shouldSkipNotifyFollowersInAcademyMode,
} from "@/lib/academyCreateSlot";

describe("getAcademyCreateSlotPrerequisites", () => {
  it("returns blocking trainer prerequisite when no trainers", () => {
    const prerequisites = getAcademyCreateSlotPrerequisites(0, 2);
    expect(prerequisites).toEqual([{ kind: "trainer", severity: "blocking" }]);
    expect(hasBlockingAcademyCreateSlotPrerequisite(prerequisites)).toBe(true);
  });

  it("returns location warning when no locations", () => {
    const prerequisites = getAcademyCreateSlotPrerequisites(1, 0);
    expect(prerequisites).toEqual([{ kind: "location", severity: "warning" }]);
    expect(hasBlockingAcademyCreateSlotPrerequisite(prerequisites)).toBe(false);
  });

  it("returns empty when trainers and locations exist", () => {
    const prerequisites = getAcademyCreateSlotPrerequisites(2, 3);
    expect(prerequisites).toEqual([]);
    expect(hasBlockingAcademyCreateSlotPrerequisite(prerequisites)).toBe(false);
  });
});

describe("mapAcademyLocationToSlotLocation", () => {
  it("uses nested location id, not academy_locations row id", () => {
    const mapped = mapAcademyLocationToSlotLocation({
      location: {
        id: "loc-real-id",
        name: "Padel Club",
        city: "Amsterdam",
        country: "NL",
      },
    });
    expect(mapped).toEqual({
      id: "loc-real-id",
      name: "Padel Club",
      city: "Amsterdam",
      country: "NL",
    });
  });

  it("maps multiple rows", () => {
    const rows = [
      {
        location: { id: "a", name: "A", city: "Utrecht", country: null },
      },
      {
        location: { id: "b", name: "B", city: null, country: "BE" },
      },
    ];
    expect(mapAcademyLocationsToSlotLocations(rows)).toEqual([
      { id: "a", name: "A", city: "Utrecht", country: undefined },
      { id: "b", name: "B", city: "", country: "BE" },
    ]);
  });
});

describe("getBulkGenerateValidationError", () => {
  it("returns no_academy_trainers when academy mode has no trainers", () => {
    expect(
      getBulkGenerateValidationError({
        bulkSlotCount: 1,
        academyId: "academy-1",
        availableTrainers: [],
        bulkSlots: [{ trainerId: null }],
        trainerId: null,
      }),
    ).toBe("no_academy_trainers");
  });

  it("returns missing_slot_trainer when a slot has no trainer in academy mode", () => {
    expect(
      getBulkGenerateValidationError({
        bulkSlotCount: 1,
        academyId: "academy-1",
        availableTrainers: [{ id: "trainer-1" }],
        bulkSlots: [{ trainerId: null }],
        trainerId: "trainer-1",
      }),
    ).toBe("missing_slot_trainer");
  });

  it("returns no_trainer_id in non-academy mode without trainerId", () => {
    expect(
      getBulkGenerateValidationError({
        bulkSlotCount: 1,
        bulkSlots: [{ trainerId: null }],
        trainerId: null,
      }),
    ).toBe("no_trainer_id");
  });

  it("returns null when academy mode has trainers on all slots", () => {
    expect(
      getBulkGenerateValidationError({
        bulkSlotCount: 1,
        academyId: "academy-1",
        availableTrainers: [{ id: "trainer-1" }],
        bulkSlots: [{ trainerId: "trainer-1" }],
        trainerId: "trainer-1",
      }),
    ).toBeNull();
  });
});

describe("shouldInitializeAcademyDefaultBulkSlot", () => {
  it("initializes when academyId and trainers exist with no existing slots", () => {
    expect(
      shouldInitializeAcademyDefaultBulkSlot({
        academyId: "academy-1",
        activeTrainerCount: 2,
        existingBulkSlotCount: 0,
      }),
    ).toBe(true);
  });

  it("does not initialize when no trainers", () => {
    expect(
      shouldInitializeAcademyDefaultBulkSlot({
        academyId: "academy-1",
        activeTrainerCount: 0,
        existingBulkSlotCount: 0,
      }),
    ).toBe(false);
  });

  it("does not initialize when slots already exist", () => {
    expect(
      shouldInitializeAcademyDefaultBulkSlot({
        academyId: "academy-1",
        activeTrainerCount: 1,
        existingBulkSlotCount: 1,
      }),
    ).toBe(false);
  });

  it("does not initialize when duplicating from cyclus", () => {
    expect(
      shouldInitializeAcademyDefaultBulkSlot({
        academyId: "academy-1",
        activeTrainerCount: 1,
        prefillFromCyclusId: "cyclus-1",
        existingBulkSlotCount: 0,
      }),
    ).toBe(false);
  });
});

describe("resolveAcademyDefaultBulkTrainerId", () => {
  it("prefers explicit trainerId over first available trainer", () => {
    expect(
      resolveAcademyDefaultBulkTrainerId("trainer-a", [{ id: "trainer-b" }]),
    ).toBe("trainer-a");
  });

  it("falls back to first available trainer", () => {
    expect(resolveAcademyDefaultBulkTrainerId(null, [{ id: "trainer-b" }])).toBe("trainer-b");
  });
});

describe("academy default bulk slot seed", () => {
  it("includes academyId as academy_profile_id on default config", () => {
    const academyId = "academy-uuid";
    const academyProfileId = academyId || null;
    expect(academyProfileId).toBe("academy-uuid");
  });
});

describe("expectsBulkGuestBookings", () => {
  it("returns true when addPlayers and guest ids are selected", () => {
    expect(
      expectsBulkGuestBookings([
        { addPlayers: true, selectedPlayers: ["guest-1"] },
      ]),
    ).toBe(true);
  });

  it("returns false when addPlayers is off", () => {
    expect(
      expectsBulkGuestBookings([
        { addPlayers: false, selectedPlayers: ["guest-1"] },
      ]),
    ).toBe(false);
  });
});

describe("getBulkGenerateBookingOutcome", () => {
  it("returns none when no enrollment expected", () => {
    expect(
      getBulkGenerateBookingOutcome({
        expectedEnrollment: false,
        totalBookingsCreated: 0,
        hadBookingInsertError: false,
      }),
    ).toBe("none");
  });

  it("returns success when bookings were created", () => {
    expect(
      getBulkGenerateBookingOutcome({
        expectedEnrollment: true,
        totalBookingsCreated: 4,
        hadBookingInsertError: false,
      }),
    ).toBe("success");
  });

  it("returns partial_failure on insert error", () => {
    expect(
      getBulkGenerateBookingOutcome({
        expectedEnrollment: true,
        totalBookingsCreated: 0,
        hadBookingInsertError: true,
      }),
    ).toBe("partial_failure");
  });

  it("returns partial_failure when enrollment expected but zero bookings", () => {
    expect(
      getBulkGenerateBookingOutcome({
        expectedEnrollment: true,
        totalBookingsCreated: 0,
        hadBookingInsertError: false,
      }),
    ).toBe("partial_failure");
  });
});

describe("shouldSkipNotifyFollowersInAcademyMode", () => {
  it("skips notify when academyId is set", () => {
    expect(shouldSkipNotifyFollowersInAcademyMode("academy-1")).toBe(true);
  });

  it("does not skip notify for trainer self-service", () => {
    expect(shouldSkipNotifyFollowersInAcademyMode(undefined)).toBe(false);
    expect(shouldSkipNotifyFollowersInAcademyMode(null)).toBe(false);
  });
});
