/**
 * Read-side timezone-correct formatting for public availability. Slots are written owner-anchored
 * (localWallTimeToUtc, e.g. Europe/Amsterdam) but a naive render uses the BROWSER timezone — wrong
 * for a cross-timezone viewer or an embedded widget on a foreign site. These helpers format a UTC
 * instant in a SPECIFIC IANA timezone (the owner's), so the displayed day + time always match where
 * the training actually is.
 */
import type { PublicSlot } from '@/lib/publicAvailability';

/** HH:mm (24h) of a UTC ISO instant in `timeZone`. */
export function formatZonedTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

/** Localized short day label (e.g. "ma 8 sep") of a UTC ISO instant in `timeZone`. */
export function formatZonedDayLabel(iso: string, timeZone: string, locale = 'nl-NL'): string {
  const opts: Intl.DateTimeFormatOptions = { timeZone, weekday: 'short', day: 'numeric', month: 'short' };
  try {
    return new Intl.DateTimeFormat(locale, opts).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat('nl-NL', opts).format(new Date(iso));
  }
}

/** yyyy-mm-dd calendar date of a UTC instant in `timeZone` — a stable per-day grouping key. */
export function zonedDateKey(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

export interface ZonedDay {
  /** yyyy-mm-dd in the owner timezone. */
  key: string;
  /** Localized short label, e.g. "ma 8 sep". */
  label: string;
  slots: PublicSlot[];
}

/**
 * Group public slots by their OWNER-timezone calendar day (not the browser's). Input is expected in
 * chronological order (the availability hook sorts by start_time), which this preserves — both the
 * day order and the slot order within a day. Pure.
 */
export function groupSlotsByZonedDay(slots: PublicSlot[], timeZone: string, locale = 'nl-NL'): ZonedDay[] {
  const map = new Map<string, ZonedDay>();
  for (const slot of slots) {
    const key = zonedDateKey(slot.start_time, timeZone);
    let day = map.get(key);
    if (!day) {
      day = { key, label: formatZonedDayLabel(slot.start_time, timeZone, locale), slots: [] };
      map.set(key, day);
    }
    day.slots.push(slot);
  }
  return [...map.values()];
}
