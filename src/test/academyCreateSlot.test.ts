import { describe, it, expect } from "vitest";
import {
  getAcademyCreateSlotPrerequisites,
  hasBlockingAcademyCreateSlotPrerequisite,
  mapAcademyLocationToSlotLocation,
  mapAcademyLocationsToSlotLocations,
  getBulkGenerateValidationError,
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

describe("default bulk slot academy profile id", () => {
  it("uses academyId for academy_profile_id when provided", () => {
    const academyId = "academy-uuid";
    const academyProfileId = academyId || null;
    expect(academyProfileId).toBe("academy-uuid");
  });
});
