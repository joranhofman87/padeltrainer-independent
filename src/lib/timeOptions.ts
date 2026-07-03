/**
 * Half-hour "HH:MM" 24-hour time-of-day options.
 *
 * `buildHalfHourOptions(startHour, endHour, { midnightEnd })` produces
 * `["HH:00", "HH:30", …]` from `startHour` to `endHour` inclusive. With
 * `midnightEnd: true` it appends `"00:00"` as an end-of-day sentinel (midnight
 * is a valid *end* time but not a valid *start*). This is the single builder
 * behind the shared `TimeSelect` dropdown and the range-limited slot/proposal
 * wizards that each previously inlined an identical loop.
 */
export function buildHalfHourOptions(
  startHour = 0,
  endHour = 23,
  { midnightEnd = false }: { midnightEnd?: boolean } = {},
): string[] {
  const options: string[] = [];
  for (let h = startHour; h <= endHour; h++) {
    options.push(`${h.toString().padStart(2, '0')}:00`);
    options.push(`${h.toString().padStart(2, '0')}:30`);
  }
  if (midnightEnd) options.push('00:00');
  return options;
}

/** The full-day half-hour list, "00:00" … "23:30" (48 entries). */
export const TIME_OPTIONS: string[] = buildHalfHourOptions();
