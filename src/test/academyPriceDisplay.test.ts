import { describe, it, expect } from "vitest";
import {
  priceDisplayModeToIncludesVat,
  includesVatToPriceDisplayMode,
  normalizePriceDisplayMode,
  getBulkCreateVatSettingsPath,
  shouldUseTrainerPricesIncludeVat,
} from "@/lib/academyPriceDisplay";

describe("priceDisplayModeToIncludesVat", () => {
  it("maps including_vat to true", () => {
    expect(priceDisplayModeToIncludesVat("including_vat")).toBe(true);
  });

  it("maps excluding_vat to false", () => {
    expect(priceDisplayModeToIncludesVat("excluding_vat")).toBe(false);
  });

  it("defaults null/undefined/unknown to including VAT", () => {
    expect(priceDisplayModeToIncludesVat(null)).toBe(true);
    expect(priceDisplayModeToIncludesVat(undefined)).toBe(true);
    expect(priceDisplayModeToIncludesVat("invalid")).toBe(true);
  });
});

describe("includesVatToPriceDisplayMode", () => {
  it("maps true to including_vat", () => {
    expect(includesVatToPriceDisplayMode(true)).toBe("including_vat");
  });

  it("maps false to excluding_vat", () => {
    expect(includesVatToPriceDisplayMode(false)).toBe("excluding_vat");
  });

  it("defaults null/undefined to including_vat", () => {
    expect(includesVatToPriceDisplayMode(null)).toBe("including_vat");
    expect(includesVatToPriceDisplayMode(undefined)).toBe("including_vat");
  });
});

describe("normalizePriceDisplayMode", () => {
  it("preserves valid modes", () => {
    expect(normalizePriceDisplayMode("excluding_vat")).toBe("excluding_vat");
    expect(normalizePriceDisplayMode("including_vat")).toBe("including_vat");
  });
});

describe("getBulkCreateVatSettingsPath", () => {
  it("points academy mode to academy settings hash", () => {
    expect(getBulkCreateVatSettingsPath("academy-uuid")).toBe(
      "/app/academy/settings#price-display",
    );
  });

  it("points trainer mode to trainer booking settings", () => {
    expect(getBulkCreateVatSettingsPath(undefined)).toBe("/app/trainer/settings/bookings");
    expect(getBulkCreateVatSettingsPath(null)).toBe("/app/trainer/settings/bookings");
  });
});

describe("shouldUseTrainerPricesIncludeVat", () => {
  it("is false when academyId is set", () => {
    expect(shouldUseTrainerPricesIncludeVat("academy-1")).toBe(false);
  });

  it("is true when academyId is absent", () => {
    expect(shouldUseTrainerPricesIncludeVat(undefined)).toBe(true);
  });
});
