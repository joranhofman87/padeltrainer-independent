import { describe, it, expect } from "vitest";
import {
  buildAcademyCalendarCyclesFallbackPath,
  buildAcademyCycleDetailPath,
} from "@/lib/cyclusPricingRoute";

/** AcademySlotDetail must not hard-link bulk cyclus_id to /app/academy/cycles/:id only. */
describe("academy slot detail cycle pricing navigation", () => {
  it("uses cycle detail path only when cycles row exists (via resolver contract)", () => {
    const bulkCyclusId = "6d1a50b3-5df8-4934-895f-efbd908fe07d";
    const fallback = buildAcademyCalendarCyclesFallbackPath(bulkCyclusId);
    expect(fallback).not.toBe(buildAcademyCycleDetailPath(bulkCyclusId));
    expect(fallback).toContain("tab=cycles");
    expect(fallback).toContain(`cyclusId=${bulkCyclusId}`);
  });
});
