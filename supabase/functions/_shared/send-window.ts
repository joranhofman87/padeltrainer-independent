// Quiet-hours guard for cron-sent emails: only send during the day (local time),
// never at night. The home market is the Netherlands, so we clamp to Amsterdam
// wall-clock time; Intl handles CET/CEST (DST) automatically. Used by the automated
// rebook reminder so a cron tick at 03:00 never actually emails anyone.

export const SEND_TIME_ZONE = "Europe/Amsterdam";
export const SEND_START_HOUR = 9; // inclusive — first hour we may send (09:00)
export const SEND_END_HOUR = 20; // exclusive — 19:xx is fine, 20:00+ is quiet

/** Current wall-clock hour (0–23) in the given IANA timezone, DST-aware. */
export function hourInTimeZone(now: Date, timeZone: string = SEND_TIME_ZONE): number {
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hour12: false,
  }).format(now);
  const h = parseInt(s, 10);
  // Some runtimes render midnight as "24" — normalise to 0.
  return Number.isNaN(h) ? 0 : h % 24;
}

/** True when `now` falls within [startHour, endHour) local time in `timeZone`. */
export function isWithinSendWindow(
  now: Date,
  timeZone: string = SEND_TIME_ZONE,
  startHour: number = SEND_START_HOUR,
  endHour: number = SEND_END_HOUR,
): boolean {
  const h = hourInTimeZone(now, timeZone);
  return h >= startHour && h < endHour;
}
