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
 * WHICH MOMENT AN EVENT IS ABOUT — read from the append-only booking lifecycle ledger.
 *
 * Two clocks were tried on the bookings row itself and both are wrong. `created_at` is immutable
 * but answers a different question, so a current cancellation of an old booking was dated back
 * three weeks, fell under the event-age floor, and was never sent. `updated_at` answers the right
 * question and is refreshed by every unrelated write, so editing a note or writing a payment id
 * re-dated a year-old cancellation into the sendable window — the laundering the whole mechanism
 * exists to prevent.
 *
 * `booking_lifecycle_events` carries one immutable row per real transition. This reads it through
 * a definer RPC so the SQL producers and these edge producers measure the floor against exactly
 * one clock.
 */
export type BookingEventKind = "created" | "confirmed" | "cancelled" | "paid" | "rejected" | "completed";

export async function occurrenceForBookingEvent(
  supabase: Db,
  bookingIds: string[],
  kind: BookingEventKind,
): Promise<string | null> {
  if (!Array.isArray(bookingIds) || bookingIds.length === 0) return null;
  const { data, error } = await supabase.rpc("booking_transition_occurred_at", {
    p_booking_ids: bookingIds,
    p_event_type: kind,
  });
  if (error) return null;
  // NULL means the transition has no ledger row — a historical one from before the ledger, or a
  // caller naming a transition that did not happen. Either way: do not enqueue.
  return typeof data === "string" && data.length > 0 ? data : null;
}

/**
 * The discriminator that makes a genuine SECOND transition of the same booking set a second
 * message. Without it the idempotency subject is (kind, booking set) alone and a
 * cancel -> re-add -> cancel is silently swallowed as a duplicate.
 */
export async function transitionSeq(
  supabase: Db,
  bookingIds: string[],
  kind: BookingEventKind,
): Promise<number | null> {
  if (!Array.isArray(bookingIds) || bookingIds.length === 0) return null;
  const { data, error } = await supabase.rpc("booking_transition_seq", {
    p_booking_ids: bookingIds,
    p_event_type: kind,
  });
  if (error) return null;
  const n = typeof data === "string" ? Number(data) : data;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
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

  // slot_reopened: the slot came free because a booking was CANCELLED, so the cancellation is the
  // event. Read from the same lifecycle ledger as every other booking transition — not from
  // `bookings.updated_at`, which any unrelated edit moves.
  //
  // The date/time fallback that used to live here read `availability_slots.updated_at`, a column
  // that does not exist in this schema (verified against the migrations and the generated types).
  // PostgREST answers 42703, the helper returns null, and the caller 503s — latent only because
  // slot_reopened currently has no in-repo invoker. It is removed rather than repaired: an
  // occurrence must come from the transition that caused it, and a slot row does not record one.
  // A caller that cannot name the booking cannot date the event, and does not send.
  if (!spec.bookingId) return null;
  return await occurrenceForBookingEvent(supabase, [spec.bookingId], "cancelled");
}
