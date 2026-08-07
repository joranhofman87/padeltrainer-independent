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

export interface BookingTransition {
  occurredAt: string;
  /** the ledger sequence of the OLDEST member's latest transition */
  seq: number | null;
  /**
   * The discriminator, over EVERY member's latest transition. One member's sequence is not enough:
   * in a two-booking set the oldest member's seq does not move when the OTHER one transitions
   * again, so a genuine second payment collapsed onto the first.
   */
  setKey: string | null;
}

/**
 * ONE call, so an occurrence can never be paired with a different transition's discriminator: a
 * transition landing between two separate reads would otherwise return the first event's instant
 * with the second event's sequence.
 */
export async function bookingTransition(
  supabase: Db,
  bookingIds: string[],
  kind: BookingEventKind,
): Promise<BookingTransition | null> {
  if (!Array.isArray(bookingIds) || bookingIds.length === 0) return null;
  const { data, error } = await supabase.rpc("booking_transition_event", {
    p_booking_ids: bookingIds,
    p_event_type: kind,
  });
  if (error) return null;
  const row = Array.isArray(data) ? data[0] : data;
  const at = (row as { occurred_at?: string } | null)?.occurred_at;
  if (typeof at !== "string" || at.length === 0) return null;
  const rawSeq = (row as { seq?: unknown } | null)?.seq;
  const seq = typeof rawSeq === "string" ? Number(rawSeq) : (typeof rawSeq === "number" ? rawSeq : null);
  const setKey = (row as { set_key?: unknown } | null)?.set_key;
  return {
    occurredAt: at,
    seq: Number.isFinite(seq as number) ? (seq as number) : null,
    setKey: typeof setKey === "string" && setKey.length > 0 ? setKey : null,
  };
}

export async function occurrenceForBookingEvent(
  supabase: Db,
  bookingIds: string[],
  kind: BookingEventKind,
): Promise<string | null> {
  return (await bookingTransition(supabase, bookingIds, kind))?.occurredAt ?? null;
}

export type OpenSlotsOccurrenceSpec =
  { subtype: "slot_reopened"; trainerId: string; bookingId?: string | null; slotDate?: string | null; slotTime?: string | null };

/**
 * For the open-slots alert: when the availability it announces actually appeared.
 *
 * `slot_reopened` announces one slot coming free, so the occurrence is when that slot was last
 * changed — the cancellation that freed it.
 *
 * THERE IS NO `new_availability` ARM ANY MORE, AND ITS REMOVAL IS THE POINT.
 *
 * It used to re-DISCOVER the announced slots from the date range:
 *
 *     .eq("trainer_id", …).gte("start_time", `${dateFrom}T00:00:00`)
 *                         .lte("start_time", `${dateTo}T23:59:59`)
 *
 * Two independent defects, either of which is enough to delete it:
 *
 *  1. OFFSETLESS LITERALS AGAINST A timestamptz COLUMN. `2026-08-10T00:00:00` carries no offset,
 *     so Postgres resolves it in the SESSION timezone — UTC for the service-role connection —
 *     while the caller derived those dates in the trainer's local timezone. Every slot in the
 *     first or last local hours of the range fell outside the window, so a batch could be dated
 *     from a slot it does not contain, or find nothing at all and 503 with nothing enqueued.
 *  2. IT MATCHED SLOTS THE CALLER NEVER CREATED. Any slot of that trainer inside the range
 *     qualified — including one created months earlier — so the occurrence of a brand-new batch
 *     could be an old row's created_at, and the activation boundary would then reject a
 *     genuinely new event.
 *
 * The producer now sends the EXACT ids, `notif_open_slots_validate_batch` proves the whole set
 * belongs to the trainer and is public, and the occurrence comes back from that same call as
 * `max_created_at` over precisely those rows. A range is no longer a way to find slots — it is
 * only ever an OUTPUT derived from slots already identified. Restoring a lookup here would
 * re-open both holes, which is why the shape no longer exists rather than merely being unused.
 */
export async function occurrenceForOpenSlots(supabase: Db, spec: OpenSlotsOccurrenceSpec): Promise<string | null> {
  if (!spec.trainerId) return null;

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
