/** Common timezone options for the timezone picker */
export const COMMON_TIMEZONES = [
  { value: 'Europe/Amsterdam', label: '🇳🇱 Amsterdam (CET/CEST)' },
  { value: 'Europe/London', label: '🇬🇧 London (GMT/BST)' },
  { value: 'Europe/Berlin', label: '🇩🇪 Berlin (CET/CEST)' },
  { value: 'Europe/Paris', label: '🇫🇷 Paris (CET/CEST)' },
  { value: 'Europe/Madrid', label: '🇪🇸 Madrid (CET/CEST)' },
  { value: 'Europe/Rome', label: '🇮🇹 Rome (CET/CEST)' },
  { value: 'Europe/Brussels', label: '🇧🇪 Brussels (CET/CEST)' },
  { value: 'Europe/Zurich', label: '🇨🇭 Zurich (CET/CEST)' },
  { value: 'Europe/Vienna', label: '🇦🇹 Vienna (CET/CEST)' },
  { value: 'Europe/Lisbon', label: '🇵🇹 Lisbon (WET/WEST)' },
  { value: 'Europe/Stockholm', label: '🇸🇪 Stockholm (CET/CEST)' },
  { value: 'Europe/Warsaw', label: '🇵🇱 Warsaw (CET/CEST)' },
  { value: 'Europe/Istanbul', label: '🇹🇷 Istanbul (TRT)' },
  { value: 'America/New_York', label: '🇺🇸 New York (EST/EDT)' },
  { value: 'America/Chicago', label: '🇺🇸 Chicago (CST/CDT)' },
  { value: 'America/Los_Angeles', label: '🇺🇸 Los Angeles (PST/PDT)' },
  { value: 'America/Sao_Paulo', label: '🇧🇷 São Paulo (BRT)' },
  { value: 'Asia/Dubai', label: '🇦🇪 Dubai (GST)' },
  { value: 'Asia/Tokyo', label: '🇯🇵 Tokyo (JST)' },
  { value: 'Australia/Sydney', label: '🇦🇺 Sydney (AEST/AEDT)' },
];

/** Get the short timezone abbreviation for display */
export function getTimezoneAbbr(timezone: string, date?: Date): string {
  try {
    const d = date || new Date();
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'short' }).formatToParts(d);
    return parts.find(p => p.type === 'timeZoneName')?.value || timezone;
  } catch {
    return timezone;
  }
}
