export type AcademyPriceDisplayMode = "including_vat" | "excluding_vat";

const VALID_MODES: AcademyPriceDisplayMode[] = ["including_vat", "excluding_vat"];

export function normalizePriceDisplayMode(
  mode: string | null | undefined,
): AcademyPriceDisplayMode {
  if (mode === "excluding_vat") {
    return "excluding_vat";
  }
  return "including_vat";
}

export function priceDisplayModeToIncludesVat(
  mode: string | null | undefined,
): boolean {
  return normalizePriceDisplayMode(mode) === "including_vat";
}

export function includesVatToPriceDisplayMode(
  includesVat: boolean | null | undefined,
): AcademyPriceDisplayMode {
  return includesVat === false ? "excluding_vat" : "including_vat";
}

export function isValidPriceDisplayMode(
  mode: string | null | undefined,
): mode is AcademyPriceDisplayMode {
  return VALID_MODES.includes(mode as AcademyPriceDisplayMode);
}

/** Bulk create / create-cycle VAT settings link target. */
export function getBulkCreateVatSettingsPath(academyId?: string | null): string {
  return academyId
    ? "/app/academy/settings#price-display"
    : "/app/trainer/settings/bookings";
}

/** Trainer profile VAT flag applies only outside academy bulk-create mode. */
export function shouldUseTrainerPricesIncludeVat(academyId?: string | null): boolean {
  return !academyId;
}
