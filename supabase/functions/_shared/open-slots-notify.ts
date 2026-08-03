/**
 * 10c-b D — the open-slots follower notification, as PRODUCTION-OWNED logic.
 *
 * WHY THIS IS A SHARED MODULE AND NOT INLINE HANDLER CODE.
 * notify-followers/index.ts ends in `serve(handler)` at module scope, so a test can never
 * import it. Every rule that matters here — what counts as a valid request, what the
 * deterministic idempotency subject is, what structured payload reaches the trusted SQL
 * renderer, and how an enqueue outcome is classified — therefore lives here, where the suite
 * exercises the real thing instead of a hand-copied approximation of it.
 *
 * THE CUTOVER. This route used to POST send-email per follower and dedup through its own
 * `notification_sends` table. It now calls `enqueue_notification('open_slots_player', ...)`
 * once per follower and lets the v2 resolver own preference, consent, suppression, contact
 * resolution and idempotency. Two consequences worth stating plainly:
 *   * there is NO "sent" outcome any more. This route ENQUEUES; whether an email is ever
 *     delivered is the worker's business and, while the digest engine is disabled, a
 *     daily/weekly follower is deliberately recorded as skipped rather than mailed.
 *   * dedup is the resolver's idempotency key (`<event>:<subject>:<recipient>`), so a retried
 *     or concurrent invocation collapses to ONE logical row. The old `notification_sends`
 *     claim/release dance is gone — keeping both would have been a dual-write with two
 *     different notions of "already handled".
 *
 * DATES ARE STRUCTURED, NEVER DISPLAY TEXT. The old caller sent
 * `date_range: "Aug 10 - Aug 16, 2026"` and the copy was built by string interpolation.
 * A digest item is immutable and hash-covered, so a locale-formatted string would freeze
 * un-parseable text into the snapshot. Callers now send ISO `date_from`/`date_to` (and
 * `slot_date`/`slot_time` for a reopened slot); the SQL renderer validates them again.
 */

/** ISO calendar date, and a real one — `2026-02-30` matches the shape but is not a date. */
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** 24-hour wall-clock time. */
export function isHhMm(v: unknown): v is string {
  return typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}

export function isUuid(v: unknown): v is string {
  return typeof v === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

export type NotifyRequest =
  | { subtype: "new_availability"; slotCount: number; dateFrom: string; dateTo: string }
  | { subtype: "slot_reopened"; slotCount: number; slotDate: string; slotTime: string; bookingId?: string };

export type ParseResult =
  | { ok: true; req: NotifyRequest }
  | { ok: false; error: string };

/**
 * Strict, allow-list validation of the request body. Rejects rather than coerces: a bad date
 * that reached the renderer would either be refused there (a 500 for the caller) or, worse,
 * frozen into an immutable digest item.
 */
export function parseNotifyRequest(raw: unknown): ParseResult {
  if (raw === null || typeof raw !== "object") return { ok: false, error: "body must be an object" };
  const b = raw as Record<string, unknown>;

  const slotCount = b.slot_count;
  if (typeof slotCount !== "number" || !Number.isInteger(slotCount) || slotCount < 1 || slotCount > 10000) {
    return { ok: false, error: "slot_count must be an integer between 1 and 10000" };
  }

  // A reopened slot is signalled by single_slot, exactly as before the cutover.
  const single = b.single_slot;
  if (single !== undefined && single !== null) {
    if (typeof single !== "object") return { ok: false, error: "single_slot must be an object" };
    const s = single as Record<string, unknown>;
    if (!isIsoDate(s.date)) return { ok: false, error: "single_slot.date must be an ISO date (YYYY-MM-DD)" };
    if (!isHhMm(s.time)) return { ok: false, error: "single_slot.time must be HH:MM" };
    if (b.booking_id !== undefined && b.booking_id !== null && !isUuid(b.booking_id)) {
      return { ok: false, error: "booking_id must be a uuid" };
    }
    return {
      ok: true,
      req: {
        subtype: "slot_reopened",
        slotCount,
        slotDate: s.date,
        slotTime: s.time,
        ...(typeof b.booking_id === "string" ? { bookingId: b.booking_id } : {}),
      },
    };
  }

  if (!isIsoDate(b.date_from)) return { ok: false, error: "date_from must be an ISO date (YYYY-MM-DD)" };
  if (!isIsoDate(b.date_to)) return { ok: false, error: "date_to must be an ISO date (YYYY-MM-DD)" };
  if (b.date_to < b.date_from) return { ok: false, error: "date_to must not precede date_from" };
  return { ok: true, req: { subtype: "new_availability", slotCount, dateFrom: b.date_from, dateTo: b.date_to } };
}

/**
 * The DETERMINISTIC per-event idempotency subject.
 *
 * The resolver's key is `<event>:<subject>:<recipient>`, so this string is what makes a retry
 * (or two concurrent invocations) collapse to one logical row per follower. It is built from
 * STRUCTURED fields only — the old version keyed on the display `date_range`, which meant a
 * locale or format change silently minted a new event and re-notified everyone.
 *
 * BJ-08 is preserved: a reopened slot keys on the cancelled booking id where one is supplied,
 * so re-opening a re-booked slot is a genuinely distinct event and still notifies; it falls
 * back to slot date/time when the caller has no booking id.
 */
export function eventSubject(req: NotifyRequest): string {
  return req.subtype === "slot_reopened"
    ? `sr:${req.bookingId ?? `${req.slotDate}:${req.slotTime}`}`
    : `na:${req.dateFrom}:${req.dateTo}`;
}

/**
 * The STRUCTURED payload handed to enqueue_notification. It carries no rendered copy: the
 * trusted SQL renderer (notif_digest_item_open_slots_v1, via notif_digest_item_for_event)
 * owns every string a recipient will read, so an edge-side format change can never alter a
 * frozen digest item.
 */
export function digestPayload(req: NotifyRequest, trainerName: string): Record<string, unknown> {
  const data: Record<string, unknown> = { trainer_name: trainerName, slot_count: req.slotCount };
  if (req.subtype === "slot_reopened") {
    data.slot_date = req.slotDate;
    data.slot_time = req.slotTime;
  } else {
    data.date_from = req.dateFrom;
    data.date_to = req.dateTo;
  }
  return { subtype: req.subtype, data };
}

/** One follower's outcome. There is deliberately no `sent` — this route only enqueues. */
export type EnqueueOutcome = "enqueued" | "skipped" | "already_existing" | "failed";

export type NotifyCounts = {
  enqueued: number;
  skipped: number;
  already_existing: number;
  failed: number;
  deferred: number;
};

export function newCounts(): NotifyCounts {
  return { enqueued: 0, skipped: 0, already_existing: 0, failed: 0, deferred: 0 };
}

/**
 * Classify what enqueue_notification actually did for one recipient.
 *
 * The RPC returns a row per outbox row it CREATED; a conflict on the idempotency key returns
 * nothing. So zero rows is not a failure — it is proof the event was already recorded for this
 * recipient, which is exactly what a retry should look like.
 */
export function classifyEnqueue(rows: Array<{ status?: string | null }> | null | undefined): EnqueueOutcome {
  if (!rows || rows.length === 0) return "already_existing";
  // A recipient can yield several channel rows; the event counts as enqueued if ANY of them is
  // live work. An all-skipped result (preference off, engine disabled, suppressed, no contact)
  // is a real, auditable outcome and must not be reported as enqueued.
  return rows.some((r) => r.status === "pending") ? "enqueued" : "skipped";
}

export function tally(counts: NotifyCounts, outcome: EnqueueOutcome): void {
  counts[outcome]++;
}
