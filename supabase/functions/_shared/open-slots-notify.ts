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


const LEGACY_MONTHS: Record<string, number> = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

/**
 * Convert the ONE legacy display range this app ever produced into ISO dates.
 *
 * Exact expected shape: `MMM d - MMM d, yyyy` (e.g. "Aug 10 - Aug 16, 2026"). The year appears
 * only on the right-hand side, so it is applied to both ends — which is correct for a bulk-slot
 * batch, and any resulting inversion is caught by the isIsoDate + ordering checks in the caller.
 * Returns null for ANY deviation; there is deliberately no fuzzy matching.
 */
export function parseLegacyDateRange(value: string): { from: string; to: string } | null {
  const m = /^([A-Z][a-z]{2}) (\d{1,2}) - ([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/.exec(value.trim());
  if (!m) return null;
  const [, fromMon, fromDay, toMon, toDay, year] = m;
  const fm = LEGACY_MONTHS[fromMon];
  const tm = LEGACY_MONTHS[toMon];
  if (!fm || !tm) return null;
  const pad = (n: string) => n.padStart(2, "0");
  const from = `${year}-${String(fm).padStart(2, "0")}-${pad(fromDay)}`;
  const to = `${year}-${String(tm).padStart(2, "0")}-${pad(toDay)}`;
  // The converted values go through the SAME validation as a native ISO body.
  if (!isIsoDate(from) || !isIsoDate(to)) return null;
  return { from, to };
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

  // ── DEPLOY-OVERLAP COMPATIBILITY (transition only; see removal note) ────────────────────
  // The frontend deploys automatically, edge functions manually, and users hold CACHED bundles
  // for a while after either. So both orders are real:
  //   * edge first  -> cached bundles still send the legacy display `date_range`;
  //   * frontend first -> the OLD handler receives an ISO-only body and keys on `undefined`.
  // A runbook cannot fix a cached bundle. So this handler ACCEPTS the legacy shape and converts
  // it, rather than 400ing and dropping the notification.
  //
  // This is NOT "inferring dates from arbitrary display text". The string is our OWN
  // deterministic output — `${format(a,"MMM d")} - ${format(b,"MMM d, yyyy")}` — so it is parsed
  // by an exact-format matcher, and the RESULT is then subjected to the same isIsoDate()
  // validation as any other input. Anything that does not match exactly is refused, so a
  // malformed or hostile value can never reach the renderer.
  //
  // REMOVE once no cached bundle sends date_range (one full frontend rollout + cache window).
  if (b.date_from === undefined && b.date_to === undefined && typeof b.date_range === "string") {
    const converted = parseLegacyDateRange(b.date_range);
    if (!converted) {
      return { ok: false, error: "date_range is no longer accepted; send ISO date_from and date_to" };
    }
    b.date_from = converted.from;
    b.date_to = converted.to;
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
 *
 * THE TRAINER IS PART OF THE KEY. The resolver's key is event + subject + RECIPIENT — it does
 * NOT include tenant/trainer. The legacy key was `${trainer_id}:${playerId}:${anchor}`, so
 * dropping the trainer here would mean a player who follows two trainers publishing the same
 * date range gets only the first: the second collapses into "already existing" and is lost.
 * The reopened fallback (no booking id) collides the same way. Hence the required argument.
 */
export function eventSubject(req: NotifyRequest, trainerId: string): string {
  if (!trainerId) throw new Error("eventSubject: trainerId is required to scope the event");
  return req.subtype === "slot_reopened"
    ? `sr:${trainerId}:${req.bookingId ?? `${req.slotDate}:${req.slotTime}`}`
    : `na:${trainerId}:${req.dateFrom}:${req.dateTo}`;
}

/**
 * The STRUCTURED payload handed to enqueue_notification. It carries no rendered copy: the
 * trusted SQL renderer (notif_digest_item_open_slots_v1, via notif_digest_item_for_event)
 * owns every string a recipient will read, so an edge-side format change can never alter a
 * frozen digest item.
 */
export function digestPayload(req: NotifyRequest, trainerName: string): Record<string, unknown> {
  const data: Record<string, unknown> = { trainer_name: trainerName };
  if (req.subtype === "slot_reopened") {
    // slot_count / date_from / date_to are REJECTED by the renderer for this subtype
    // (20261010100000: "date_from/date_to/slot_count are not permitted for slot_reopened").
    // Sending them anyway would make every reopened event raise once the engine is enabled.
    data.slot_date = req.slotDate;
    data.slot_time = req.slotTime;
  } else {
    data.slot_count = req.slotCount;
    data.date_from = req.dateFrom;
    data.date_to = req.dateTo;
  }
  return { subtype: req.subtype, data };
}

/**
 * One follower's outcome. There is deliberately no `sent` — this route only enqueues.
 *
 * `no_row` rather than `already_existing`: a zero-row RPC result is AMBIGUOUS. It means either
 * an idempotency-key conflict (the event was already recorded — a retry) OR that the resolver
 * emitted nothing at all, which for this non-required event happens on preference 'off', a
 * missing/suppressed contact, or no deliverable channel. Reporting both as "already existing"
 * would make a whole cohort of never-notified followers look like successful de-duplication.
 */
export type EnqueueOutcome = "enqueued" | "skipped" | "no_row" | "failed";

export type NotifyCounts = {
  enqueued: number;
  skipped: number;
  no_row: number;
  failed: number;
  deferred: number;
};

export function newCounts(): NotifyCounts {
  return { enqueued: 0, skipped: 0, no_row: 0, failed: 0, deferred: 0 };
}

/**
 * Classify what enqueue_notification actually did for one recipient.
 *
 * The RPC returns a row per outbox row it CREATED. Zero rows is NOT a failure, but neither is
 * it proof of a retry: for a non-required event the resolver also returns nothing when the
 * preference is 'off', when there is no deliverable contact, and when the address is
 * suppressed. Those are "we did not notify this person", not "we already had". The two cannot
 * be told apart from the RPC's return value, so they share one honest bucket — `no_row` — and
 * the name does not overstate what is known.
 */
export function classifyEnqueue(rows: Array<{ status?: string | null }> | null | undefined): EnqueueOutcome {
  if (!rows || rows.length === 0) return "no_row";
  // A recipient can yield several channel rows; the event counts as enqueued if ANY of them is
  // live work. An all-skipped result (preference off, engine disabled, suppressed, no contact)
  // is a real, auditable outcome and must not be reported as enqueued.
  return rows.some((r) => r.status === "pending") ? "enqueued" : "skipped";
}

export function tally(counts: NotifyCounts, outcome: EnqueueOutcome): void {
  counts[outcome]++;
}
