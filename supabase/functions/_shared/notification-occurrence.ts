/**
 * WHEN THE THING HAPPENED — derived from the database, never from the caller and never from the
 * clock at the moment we happened to get around to it.
 *
 * The final audit's second round found the no-backlog contract measuring the wrong clock: every
 * send authority gated on `notification_outbox.created_at`, which is when the ROW was written. The
 * two coincide only while every producer enqueues synchronously with its event — and none of ours
 * strictly does. Slot creation commits, then the follower notification is invoked separately and
 * retried on its own budget; a Mollie webhook can be redelivered days later; a manual replay is
 * one curl away. In each of those the row is written NOW for something that happened THEN, and a
 * boundary reading created_at waves it through.
 *
 * So the producer must declare the occurrence, and these helpers derive it from the domain row the
 * event is ABOUT. Deriving beats accepting a parameter for the same reason the resolver renders
 * its own copy: a timestamp that decides whether a year of history may be mailed out is not
 * something an untrusted request body gets to assert.
 *
 * FAIL CLOSED, deliberately. Every helper returns null when it cannot establish the time, and
 * every caller must treat null as "do not enqueue" rather than falling back to now(). A fallback
 * to now() is precisely the bug: it re-creates the hole for exactly the cases — a missing row, an
 * unreadable table, an unexpected shape — where something is already wrong. A notification we
 * cannot date is one we do not send; the domain write has already committed either way, and the
 * caller's bounded retry gets another chance.
 */

// The Supabase client's generated types are not available to edge functions, and every consumer
// here uses only .from().select() — the shape, not the schema.
// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

/**
 * For an event ABOUT bookings: the earliest booking the message reports.
 *
 * The earliest rather than the latest, because the floor must be conservative — a message covering
 * one old session and one new one is, in the part that matters, old.
 */
export async function occurrenceForBookings(supabase: Db, bookingIds: string[]): Promise<string | null> {
  if (!Array.isArray(bookingIds) || bookingIds.length === 0) return null;
  const { data, error } = await supabase
    .from("bookings")
    .select("created_at")
    .in("id", bookingIds)
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) return null;
  const row = Array.isArray(data) ? data[0] : null;
  const at = row?.created_at;
  return typeof at === "string" && at.length > 0 ? at : null;
}

export type OpenSlotsOccurrenceSpec =
  | { subtype: "new_availability"; trainerId: string; dateFrom: string; dateTo: string }
  | { subtype: "slot_reopened"; trainerId: string; bookingId?: string | null; slotDate?: string | null; slotTime?: string | null };

/**
 * For the open-slots alert: when the availability it announces actually appeared.
 *
 * `new_availability` announces a batch, so the occurrence is the NEWEST slot in the announced
 * range — the moment the thing being announced became true. (The earliest would be wrong here in a
 * way it is not for bookings: a range can legitimately contain slots posted weeks ago beside the
 * ones just created, and dating the announcement to the oldest would refuse a genuinely new event.)
 *
 * `slot_reopened` announces one slot coming free, so the occurrence is when that slot was last
 * changed — the cancellation that freed it.
 */
export async function occurrenceForOpenSlots(supabase: Db, spec: OpenSlotsOccurrenceSpec): Promise<string | null> {
  if (!spec.trainerId) return null;

  if (spec.subtype === "new_availability") {
    if (!spec.dateFrom || !spec.dateTo) return null;
    const { data, error } = await supabase
      .from("availability_slots")
      .select("created_at")
      .eq("trainer_id", spec.trainerId)
      .gte("start_time", `${spec.dateFrom}T00:00:00`)
      .lte("start_time", `${spec.dateTo}T23:59:59`)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) return null;
    const at = (Array.isArray(data) ? data[0] : null)?.created_at;
    return typeof at === "string" && at.length > 0 ? at : null;
  }

  // slot_reopened: prefer the booking whose cancellation freed the slot; fall back to the slot
  // itself when the caller identified it by date/time instead.
  if (spec.bookingId) {
    const { data, error } = await supabase
      .from("bookings")
      .select("updated_at")
      .eq("id", spec.bookingId)
      .limit(1);
    if (error) return null;
    const at = (Array.isArray(data) ? data[0] : null)?.updated_at;
    if (typeof at === "string" && at.length > 0) return at;
    return null;
  }
  if (!spec.slotDate || !spec.slotTime) return null;
  const { data, error } = await supabase
    .from("availability_slots")
    .select("updated_at")
    .eq("trainer_id", spec.trainerId)
    .gte("start_time", `${spec.slotDate}T00:00:00`)
    .lte("start_time", `${spec.slotDate}T23:59:59`)
    .order("updated_at", { ascending: false })
    .limit(1);
  if (error) return null;
  const at = (Array.isArray(data) ? data[0] : null)?.updated_at;
  return typeof at === "string" && at.length > 0 ? at : null;
}
