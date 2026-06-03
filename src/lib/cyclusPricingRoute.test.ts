import { describe, it, expect, vi, beforeEach } from "vitest";

const maybeSingleMock = vi.fn();

vi.mock("@/lib/supabaseClient", () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: maybeSingleMock,
        })),
      })),
    })),
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}));

import {
  buildAcademyCalendarCyclesFallbackPath,
  buildAcademyCycleDetailPath,
  lookupCyclesRowById,
  resolveAcademyCyclusPricingRoute,
} from "@/lib/cyclusPricingRoute";

describe("buildAcademyCyclusPricingPaths", () => {
  it("builds cycle detail path", () => {
    expect(buildAcademyCycleDetailPath("abc-123")).toBe("/app/academy/cycles/abc-123");
  });

  it("builds calendar list tab fallback with cyclusId", () => {
    expect(buildAcademyCalendarCyclesFallbackPath("abc-123")).toBe(
      "/app/academy/calendar?tab=list&cyclusId=abc-123",
    );
  });
});

describe("lookupCyclesRowById", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns exists when row is found", async () => {
    maybeSingleMock.mockResolvedValue({ data: { id: "cycle-1" }, error: null });
    await expect(lookupCyclesRowById("cycle-1")).resolves.toBe("exists");
  });

  it("returns missing when no row (bulk orphan cyclus)", async () => {
    maybeSingleMock.mockResolvedValue({ data: null, error: null });
    await expect(lookupCyclesRowById("orphan-cyclus")).resolves.toBe("missing");
  });

  it("returns error on query failure", async () => {
    maybeSingleMock.mockResolvedValue({
      data: null,
      error: { code: "42501", message: "permission denied" },
    });
    await expect(lookupCyclesRowById("cycle-1")).resolves.toBe("error");
  });
});

describe("resolveAcademyCyclusPricingRoute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes to cycle detail when cycles row exists", async () => {
    maybeSingleMock.mockResolvedValue({ data: { id: "real-cycle" }, error: null });
    await expect(resolveAcademyCyclusPricingRoute("real-cycle")).resolves.toBe(
      "/app/academy/cycles/real-cycle",
    );
  });

  it("routes to calendar list tab when row is missing", async () => {
    maybeSingleMock.mockResolvedValue({ data: null, error: null });
    await expect(resolveAcademyCyclusPricingRoute("bulk-cyclus")).resolves.toBe(
      "/app/academy/calendar?tab=list&cyclusId=bulk-cyclus",
    );
  });

  it("falls back to calendar on lookup error", async () => {
    maybeSingleMock.mockResolvedValue({
      data: null,
      error: { message: "network" },
    });
    await expect(resolveAcademyCyclusPricingRoute("any-id")).resolves.toBe(
      "/app/academy/calendar?tab=list&cyclusId=any-id",
    );
  });
});
