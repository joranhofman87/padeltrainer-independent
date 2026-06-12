// ISO 3166-1 alpha-2 country codes. The static map is the English canonical
// fallback; use getCountryName(code, locale) for localized display — it goes
// through Intl.DisplayNames so NL users see "Nederland", EN users
// "Netherlands", from ONE stored code (W-06: the directory previously stored
// free-text country names, splitting Dutch clubs across "NL"/"Netherlands").
// locations.country is constrained to ^[A-Z]{2}$ since 20260612160000.
export const COUNTRIES = {
  NL: 'Netherlands',
  BE: 'Belgium',
  DE: 'Germany',
  ES: 'Spain',
  FR: 'France',
  GB: 'United Kingdom',
  IT: 'Italy',
  PT: 'Portugal',
  AT: 'Austria',
  CH: 'Switzerland',
  SE: 'Sweden',
  DK: 'Denmark',
  NO: 'Norway',
  FI: 'Finland',
  PL: 'Poland',
  CZ: 'Czech Republic',
  AE: 'United Arab Emirates',
  US: 'United States',
  IE: 'Ireland',
  PK: 'Pakistan',
  CA: 'Canada',
  MX: 'Mexico',
  PH: 'Philippines',
  AU: 'Australia',
  UA: 'Ukraine',
  CL: 'Chile',
  CO: 'Colombia',
  MY: 'Malaysia',
  AR: 'Argentina',
  BG: 'Bulgaria',
  BH: 'Bahrain',
  BO: 'Bolivia',
  BR: 'Brazil',
  CN: 'China',
  CR: 'Costa Rica',
  CY: 'Cyprus',
  DO: 'Dominican Republic',
  EC: 'Ecuador',
  EE: 'Estonia',
  EG: 'Egypt',
  GR: 'Greece',
  HR: 'Croatia',
  HU: 'Hungary',
  ID: 'Indonesia',
  IL: 'Israel',
  IN: 'India',
  JP: 'Japan',
  KE: 'Kenya',
  KW: 'Kuwait',
  LT: 'Lithuania',
  LV: 'Latvia',
  MA: 'Morocco',
  MT: 'Malta',
  NG: 'Nigeria',
  NZ: 'New Zealand',
  PA: 'Panama',
  PE: 'Peru',
  QA: 'Qatar',
  RO: 'Romania',
  RS: 'Serbia',
  SA: 'Saudi Arabia',
  SG: 'Singapore',
  SK: 'Slovakia',
  TH: 'Thailand',
  TN: 'Tunisia',
  TR: 'Turkey',
  UY: 'Uruguay',
  VE: 'Venezuela',
  VN: 'Vietnam',
  ZA: 'South Africa',
  ZZ: 'Other',
} as const;

export type CountryCode = keyof typeof COUNTRIES;

const displayNamesCache = new Map<string, Intl.DisplayNames>();

function displayNamesFor(locale: string): Intl.DisplayNames | null {
  if (!displayNamesCache.has(locale)) {
    try {
      displayNamesCache.set(locale, new Intl.DisplayNames([locale], { type: 'region' }));
    } catch {
      return null;
    }
  }
  return displayNamesCache.get(locale) ?? null;
}

/** Localized country name for an ISO code: ("NL", "nl") → "Nederland". */
export function getCountryName(code: string, locale?: string): string {
  const upper = code.toUpperCase();
  if (upper === 'ZZ') return COUNTRIES.ZZ;
  if (locale) {
    const dn = displayNamesFor(locale);
    const localized = dn?.of(upper);
    // Intl returns the input code itself for unknown codes — treat as a miss.
    if (localized && localized !== upper) return localized;
  }
  return COUNTRIES[upper as CountryCode] || upper;
}

/** Sorted [{code, name}] options for country selects, localized when possible. */
export function getCountrySelectOptions(locale?: string): { code: string; name: string }[] {
  return (Object.keys(COUNTRIES) as CountryCode[])
    .filter((c) => c !== 'ZZ')
    .map((code) => ({ code, name: getCountryName(code, locale) }))
    .sort((a, b) => a.name.localeCompare(b.name, locale));
}
