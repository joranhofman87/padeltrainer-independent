/**
 * Player booking cutoff — the CLIENT-SIDE view of a rule the database owns.
 *
 * The server decides: can_book_slot() returns 'booking_cutoff' and the guest checkout functions
 * refuse, both using the database clock. This module exists only so the UI can hide or disable
 * a slot the player cannot book, instead of letting them pick it, fill a form and be rejected.
 *
 * It is therefore ADVISORY. A clock skewed by a few minutes changes what the page offers; it
 * never changes what gets booked. That asymmetry is deliberate — if these two ever disagree the
 * server wins, and the only cost is a slot that looks bookable and then isn't.
 *
 * Mirrors the SQL exactly, including the two things that are easy to get wrong:
 *   * the STRICTER of academy and trainer wins (so a trainer can tighten, never loosen),
 *   * a cutoff of 0 blocks NOTHING, including sessions that have already started.
 */

/** Minutes. Matches the CHECK constraint on both settings columns. */
export const MAX_BOOKING_CUTOFF_MINUTES = 10080; // 7 days

/** The preset ladder offered in both settings pages. 0 = no cutoff. */
export const BOOKING_CUTOFF_PRESETS = [0, 120, 360, 720, 1440, 2880, 4320, 10080] as const;

/**
 * The strictest of the two tenant settings, NULLs treated as 0.
 * An independent trainer's slot has no academy, so it uses the trainer's own value.
 */
export function effectiveCutoffMinutes(
  academyMinutes: number | null | undefined,
  trainerMinutes: number | null | undefined,
): number {
  return Math.max(academyMinutes ?? 0, trainerMinutes ?? 0, 0);
}

/**
 * Is this slot inside its cutoff, i.e. too late for a player to self-book?
 *
 * `now` is injectable so tests do not depend on wall-clock time; production passes the real
 * clock, which is exactly the advisory part.
 */
export function isSlotWithinCutoff(
  slotStartTime: string | Date | null | undefined,
  cutoffMinutes: number,
  now: Date = new Date(),
): boolean {
  if (!slotStartTime) return false;
  // 0 means no rule at all — not even for a session that already started. Preserving that is
  // what makes the default a genuine no-op for every academy that never sets one.
  if (!cutoffMinutes || cutoffMinutes <= 0) return false;

  const start = slotStartTime instanceof Date ? slotStartTime : new Date(slotStartTime);
  if (Number.isNaN(start.getTime())) return false;   // unparseable: let the server decide

  const minutesUntilStart = (start.getTime() - now.getTime()) / 60000;
  return minutesUntilStart < cutoffMinutes;
}

/** Human label for a preset, e.g. 2880 → "48 uur". Used by the settings dropdowns. */
export function formatCutoffMinutes(
  minutes: number,
  t: (key: string, fallback: string, opts?: Record<string, unknown>) => string,
): string {
  if (!minutes || minutes <= 0) return t('bookingCutoff.none', 'Geen limiet');
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return days === 7
      ? t('bookingCutoff.week', '7 dagen')
      : t('bookingCutoff.days', '{{count}} dagen', { count: days });
  }
  return t('bookingCutoff.hours', '{{count}} uur', { count: minutes / 60 });
}
