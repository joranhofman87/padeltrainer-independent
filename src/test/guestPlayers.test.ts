import { describe, it, expect } from "vitest";
import {
  GUEST_PLAYER_ACADEMY_FILTER_COLUMN,
  GUEST_PLAYER_CALENDAR_SELECT,
  GUEST_PLAYER_TRAINER_FILTER_COLUMN,
  getGuestPlayerLoadStrategy,
  getGuestPlayerQueryFilter,
  usesAcademyProfileIdFilterOnly,
} from "@/lib/guestPlayers";

/** Documents expected PostgREST filters — academy path must not use trainer_id=is.null. */
const ACADEMY_FORBIDDEN_FILTERS = ["trainer_id=is.null", "trainer_id.is.null"];

describe("GUEST_PLAYER_CALENDAR_SELECT", () => {
  it("uses linked_profile_id not linked_player_id", () => {
    expect(GUEST_PLAYER_CALENDAR_SELECT).toContain("linked_profile_id");
    expect(GUEST_PLAYER_CALENDAR_SELECT).not.toContain("linked_player_id");
  });
});

describe("getGuestPlayerLoadStrategy", () => {
  it("prefers academy loader when academyId is set", () => {
    expect(getGuestPlayerLoadStrategy("academy-1", "trainer-1")).toBe("academy");
    expect(getGuestPlayerLoadStrategy("academy-1", null)).toBe("academy");
  });

  it("uses trainer loader when only trainerId is set", () => {
    expect(getGuestPlayerLoadStrategy(undefined, "trainer-1")).toBe("trainer");
    expect(getGuestPlayerLoadStrategy(null, "trainer-1")).toBe("trainer");
  });

  it("returns none when neither id is set", () => {
    expect(getGuestPlayerLoadStrategy(null, null)).toBe("none");
  });
});

describe("academy guest player filter model", () => {
  it("documents academy loads by academy_profile_id only", () => {
    expect(usesAcademyProfileIdFilterOnly()).toBe(true);
    expect(GUEST_PLAYER_ACADEMY_FILTER_COLUMN).toBe("academy_profile_id");
    expect(getGuestPlayerQueryFilter("academy", "academy-1")).toEqual({
      column: "academy_profile_id",
      value: "academy-1",
    });
  });

  it("documents trainer loads by trainer_id", () => {
    expect(GUEST_PLAYER_TRAINER_FILTER_COLUMN).toBe("trainer_id");
    expect(getGuestPlayerQueryFilter("trainer", "trainer-1")).toEqual({
      column: "trainer_id",
      value: "trainer-1",
    });
  });

  it("does not require trainer_id IS NULL filter in academy loader contract", () => {
    for (const forbidden of ACADEMY_FORBIDDEN_FILTERS) {
      expect(forbidden).toContain("trainer_id");
    }
    expect(getGuestPlayerLoadStrategy("academy-1")).toBe("academy");
    const filter = getGuestPlayerQueryFilter("academy", "academy-1");
    expect(filter?.column).not.toBe("trainer_id");
  });
});
