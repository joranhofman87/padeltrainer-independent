/**
 * Per-cycle "may the WHOLE cyclus be booked in one go?" rule.
 *
 * cycles.settings.allow_cyclus_booking — absent/true ⇒ bookable (the long-standing
 * default), explicitly false ⇒ the cyclus may only be consumed as individual sessions
 * (allow_single_booking) and create-guest-cyclus-payment refuses the whole-series
 * checkout. The public dialog reads the same flag via cycles_public and hides the
 * whole-cyclus option; this server-side rule is the authoritative one (the endpoint
 * is verify_jwt=false and must not trust the UI).
 *
 * First user: RL Padel Performance — per-seat drop-in sessions only, no series checkout.
 */
export function isCyclusBookingAllowed(settings: unknown): boolean {
  if (!settings || typeof settings !== "object") return true;
  return (settings as Record<string, unknown>)["allow_cyclus_booking"] !== false;
}
