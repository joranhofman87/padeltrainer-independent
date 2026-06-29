/**
 * Pure date-math for the quick slot/cycle generator.
 *
 * `planSlots(config)` expands a single weekly rule — a daily begin→end window
 * filled back-to-back with fixed-duration slots, an optional blocked break
 * window, on chosen weekdays, across a date range, skipping holiday ranges —
 * into a flat, sorted list of `{ startISO, endISO }` slot drafts.
 *
 * It is PURE and deterministic: no `Date.now()`, no randomness, no I/O. All
 * times are anchored to the owner's wall clock in `timezone` and emitted as
 * UTC ISO strings (DST-correct via the standard offset trick), so an 18:00
 * session stays 18:00 local across a daylight-saving change. The caller
 * resolves `timezone` from `academy_profiles.timezone` / `trainer_profiles.timezone`
 * (both default `Europe/Amsterdam`) — never the browser timezone.
 */

export type Weekday =
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday'
  | 'sunday';

/** Inclusive holiday range; `from`/`to` are `yyyy-mm-dd` local dates. */
export interface HolidayRange {
  from: string;
  to: string;
  name?: string;
}

export interface SlotPlanConfig {
  /** Weekdays to plan on (lowercase English day names). */
  weekdays: Weekday[];
  /** Daily window start, `HH:mm` (24h). */
  windowStart: string;
  /** Daily window end, `HH:mm` (24h), must be after `windowStart` (no overnight). */
  windowEnd: string;
  /** Length of each slot in minutes (> 0). */
  slotDurationMin: number;
  /** Optional blocked break window start, `HH:mm`. */
  breakStart?: string;
  /** Optional blocked break window end, `HH:mm` (must be after `breakStart`). */
  breakEnd?: string;
  /** First date to consider, `yyyy-mm-dd` (local). */
  startDate: string;
  /** Number of weeks from `startDate` (provide this OR `endDate`, not both). */
  weeks?: number;
  /** Inclusive last date, `yyyy-mm-dd` (provide this OR `weeks`, not both). */
  endDate?: string;
  /** Date ranges on which nothing is planned. */
  holidayRanges?: HolidayRange[];
  /** IANA timezone the window/duration are expressed in. */
  timezone: string;
}

export interface SlotDraft {
  /** Slot start as a UTC ISO string. */
  startISO: string;
  /** Slot end as a UTC ISO string (= start + slotDurationMin). */
  endISO: string;
}

/** Safety cap — a single generate must never fan out beyond this many slots. */
export const MAX_PLANNED_SLOTS = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

const WEEKDAYS: readonly Weekday[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

/** Error thrown for an invalid or out-of-bounds slot-plan config. */
export class SlotPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlotPlanError';
  }
}

/** `HH:mm` → minutes since local midnight. Throws on malformed input. */
function parseHHmm(value: string, field: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(value ?? '');
  if (!m) throw new SlotPlanError(`${field} must be HH:mm (got ${JSON.stringify(value)})`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new SlotPlanError(`${field} is out of range (got ${value})`);
  return h * 60 + min;
}

/** `yyyy-mm-dd` validation. Throws on malformed input. */
function assertYmd(value: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) {
    throw new SlotPlanError(`${field} must be yyyy-mm-dd (got ${JSON.stringify(value)})`);
  }
}

/**
 * The UTC instant whose LOCAL wall-clock time (in `tz`) is y-mo-d h:mi.
 * Standard offset trick — correct except inside the ~1h DST-transition window.
 * Ported verbatim from `supabase/functions/bulk-rebook-cycle/index.ts` so the
 * client generator and the rebook edge function anchor wall-clock identically.
 */
function localWallTimeToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  tz: string,
): Date {
  const guess = Date.UTC(y, mo, d, h, mi, 0);
  const asUtc = new Date(new Date(guess).toLocaleString('en-US', { timeZone: 'UTC' })).getTime();
  const asTz = new Date(new Date(guess).toLocaleString('en-US', { timeZone: tz })).getTime();
  return new Date(guess + (asUtc - asTz));
}

/**
 * Expand a weekly slot rule into concrete `{ startISO, endISO }` drafts.
 *
 * Algorithm:
 *  1. Walk every local date in [startDate, end] (end = startDate + weeks·7−1, or endDate).
 *  2. Keep dates whose weekday (in `timezone`) is in `weekdays` and that fall in NO holiday range.
 *  3. Within each kept day, step `windowStart → windowEnd` by `slotDurationMin`,
 *     dropping the trailing partial slot (`m + dur > windowEnd`) and any slot that
 *     OVERLAPS the half-open break window `[breakStart, breakEnd)`.
 *
 * @throws {SlotPlanError} on invalid config or if the result would exceed MAX_PLANNED_SLOTS.
 */
export function planSlots(config: SlotPlanConfig): SlotDraft[] {
  const { weekdays, slotDurationMin, startDate, weeks, endDate, timezone } = config;

  if (!timezone) throw new SlotPlanError('timezone is required');
  if (!weekdays || weekdays.length === 0) throw new SlotPlanError('Select at least one weekday');
  for (const wd of weekdays) {
    if (!WEEKDAYS.includes(wd)) throw new SlotPlanError(`Unknown weekday ${JSON.stringify(wd)}`);
  }
  if (!Number.isInteger(slotDurationMin) || slotDurationMin <= 0) {
    throw new SlotPlanError('slotDurationMin must be a positive integer');
  }

  const windowStartMin = parseHHmm(config.windowStart, 'windowStart');
  const windowEndMin = parseHHmm(config.windowEnd, 'windowEnd');
  if (windowEndMin <= windowStartMin) {
    throw new SlotPlanError('windowEnd must be after windowStart (overnight windows are not supported)');
  }

  let breakStartMin: number | null = null;
  let breakEndMin: number | null = null;
  if (config.breakStart || config.breakEnd) {
    if (!config.breakStart || !config.breakEnd) {
      throw new SlotPlanError('a break needs both breakStart and breakEnd');
    }
    breakStartMin = parseHHmm(config.breakStart, 'breakStart');
    breakEndMin = parseHHmm(config.breakEnd, 'breakEnd');
    if (breakEndMin <= breakStartMin) throw new SlotPlanError('breakEnd must be after breakStart');
  }

  assertYmd(startDate, 'startDate');
  const hasWeeks = weeks !== undefined && weeks !== null;
  const hasEndDate = endDate !== undefined && endDate !== null && endDate !== '';
  if (hasWeeks === hasEndDate) {
    throw new SlotPlanError('provide exactly one of weeks or endDate');
  }

  // Step days from noon-UTC on startDate; noon ± a DST hour stays the same local date.
  const startAnchor = new Date(`${startDate}T12:00:00.000Z`).getTime();
  let dayCount: number;
  if (hasWeeks) {
    if (!Number.isInteger(weeks) || (weeks as number) <= 0) {
      throw new SlotPlanError('weeks must be a positive integer');
    }
    dayCount = (weeks as number) * 7;
  } else {
    assertYmd(endDate as string, 'endDate');
    const endAnchor = new Date(`${endDate}T12:00:00.000Z`).getTime();
    if (endAnchor < startAnchor) throw new SlotPlanError('endDate must be on or after startDate');
    dayCount = Math.round((endAnchor - startAnchor) / DAY_MS) + 1; // inclusive
  }

  const holidays = (config.holidayRanges ?? []).filter((h) => h && h.from && h.to);
  const wdFmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' });
  const ymdFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const wanted = new Set<Weekday>(weekdays);

  const out: SlotDraft[] = [];
  for (let i = 0; i < dayCount; i++) {
    const dayAnchor = new Date(startAnchor + i * DAY_MS);
    const weekday = wdFmt.format(dayAnchor).toLowerCase() as Weekday;
    if (!wanted.has(weekday)) continue;

    const dateStr = ymdFmt.format(dayAnchor); // yyyy-mm-dd in tz
    if (holidays.some((h) => dateStr >= h.from && dateStr <= h.to)) continue;

    const [y, mo, d] = dateStr.split('-').map(Number);
    for (let m = windowStartMin; m + slotDurationMin <= windowEndMin; m += slotDurationMin) {
      const slotEnd = m + slotDurationMin;
      // Drop any slot overlapping the half-open break window [breakStart, breakEnd).
      if (breakStartMin !== null && breakEndMin !== null && m < breakEndMin && slotEnd > breakStartMin) {
        continue;
      }
      const start = localWallTimeToUtc(y, mo - 1, d, Math.floor(m / 60), m % 60, timezone);
      out.push({
        startISO: start.toISOString(),
        endISO: new Date(start.getTime() + slotDurationMin * 60_000).toISOString(),
      });
      if (out.length > MAX_PLANNED_SLOTS) {
        throw new SlotPlanError(
          `Slot plan exceeds the maximum of ${MAX_PLANNED_SLOTS} slots — narrow the date range, window, or weekdays`,
        );
      }
    }
  }

  // Generated in chronological order already, but sort defensively.
  out.sort((a, b) => (a.startISO < b.startISO ? -1 : a.startISO > b.startISO ? 1 : 0));
  return out;
}
