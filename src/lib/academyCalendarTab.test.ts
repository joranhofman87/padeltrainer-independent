import { describe, it, expect } from "vitest";
import {
  parseAcademyCalendarTab,
  isAcademyCalendarListTab,
} from "@/lib/academyCalendarTab";

describe("parseAcademyCalendarTab", () => {
  it("opens list view when tab=list", () => {
    expect(parseAcademyCalendarTab("list")).toBe("list");
  });

  it("maps tab=cycles to list alias", () => {
    expect(parseAcademyCalendarTab("cycles")).toBe("list");
  });

  it("opens month view when tab=month", () => {
    expect(parseAcademyCalendarTab("month")).toBe("month");
  });

  it("defaults to week when tab is missing", () => {
    expect(parseAcademyCalendarTab(null)).toBe("week");
  });

  it("maps legacy overview and manage tabs", () => {
    expect(parseAcademyCalendarTab("overview")).toBe("week");
    expect(parseAcademyCalendarTab("manage")).toBe("day");
  });
});

describe("isAcademyCalendarListTab", () => {
  it("returns true for list and cycles", () => {
    expect(isAcademyCalendarListTab("list")).toBe(true);
    expect(isAcademyCalendarListTab("cycles")).toBe(true);
    expect(isAcademyCalendarListTab("month")).toBe(false);
  });
});
