// ISO 3166-1 alpha-2 country codes mapped to country names
export const COUNTRIES = {
  NL: 'Nederland',
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
} as const;

export type CountryCode = keyof typeof COUNTRIES;

export function getCountryName(code: string): string {
  return COUNTRIES[code as CountryCode] || code;
}
