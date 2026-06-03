import { describe, it, expect } from "vitest";

type TabValue = "week" | "day" | "month" | "cycles" | "create" | "hours" | "reports";

/** Mirrors AcademyCalendar tab parsing from URL search params. */
export function parseAcademyCalendarTab(rawTab: string | null): TabValue {
  const tab = rawTab || "week";
  if (tab === "overview") return "week";
  if (tab === "manage") return "day";
  if (["week", "day", "month", "cycles", "create", "hours", "reports"].includes(tab)) {
    return tab as TabValue;
  }
  return "week";
}

describe("parseAcademyCalendarTab", () => {
  it("opens cycles tab when tab=cycles", () => {
    expect(parseAcademyCalendarTab("cycles")).toBe("cycles");
  });

  it("defaults to week when tab is missing", () => {
    expect(parseAcademyCalendarTab(null)).toBe("week");
  });
});
