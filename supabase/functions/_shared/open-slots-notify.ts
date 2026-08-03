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

const LEGACY_MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * The CANONICAL legacy display range, and the ONE place its format is defined.
 *
 * Two shapes, and the difference is a correctness fix rather than cosmetics:
 *   * same year  -> `MMM d - MMM d, yyyy`   ("Aug 10 - Aug 16, 2026")
 *   * different  -> `MMM d, yyyy - MMM d, yyyy`  ("Dec 29, 2026 - Jan 5, 2027")
 *
 * The historical producer printed the year ONLY on the right, which is ambiguous the moment a
 * batch spans a year boundary: "Jan 1 - Jan 2, 2027" is produced by BOTH 2027-01-01..2027-01-02
 * and 2026-01-01..2027-01-02, and nothing in the string distinguishes them. The bulk-slot form
 * imposes no span limit — each entry recurs up to 52 weeks and a batch may contain several
 * entries with unrelated start dates (`BulkCreateContent.tsx`) — so multi-year ranges are
 * genuinely reachable. Emitting both years whenever they differ makes every string this app
 * produces from now on parse back to exactly one range.
 *
 * The OLD handler treats this value as opaque display text plus a dedup anchor, so widening the
 * format is safe for it: it renders the string and keys on it, and both remain self-consistent.
 */
export function formatLegacyDateRange(fromIso: string, toIso: string): string {
  const part = (iso: string) => {
    const [y, m, d] = iso.split("-");
    return { y, mon: LEGACY_MONTH_NAMES[Number(m) - 1], d: String(Number(d)) };
  };
  const a = part(fromIso);
  const b = part(toIso);
  return a.y === b.y
    ? `${a.mon} ${a.d} - ${b.mon} ${b.d}, ${b.y}`
    : `${a.mon} ${a.d}, ${a.y} - ${b.mon} ${b.d}, ${b.y}`;
}

/**
 * Convert a legacy display range back into ISO dates.
 *
 * Two accepted shapes, mirroring formatLegacyDateRange:
 *
 *  1. `MMM d, yyyy - MMM d, yyyy` — UNAMBIGUOUS. Both years are explicit, nothing is inferred.
 *     This is what every current bundle emits for a year-crossing batch.
 *
 *  2. `MMM d - MMM d, yyyy` — the HISTORICAL shape, still sent by cached pre-cutover bundles.
 *     The year is printed only on the right, so the left year is either that year or the one
 *     before it. It is resolved to the SMALLEST non-negative span: the printed year for both
 *     ends, dropping to year-1 on the left when that would invert the range. This is what fixes
 *     a reachable 52-week series such as 2026-01-10 -> 2027-01-02 ("Jan 10 - Jan 2, 2027"),
 *     which the previous month-only rollover test rejected outright.
 *
 *     LIMIT, stated rather than hidden: this shape CANNOT express a span of a year or more. A
 *     cached pre-cutover bundle publishing a multi-year batch therefore yields the shorter
 *     reading. Nothing in the string can distinguish the two, so the closure is operational —
 *     the rollout deploys the frontend first and waits out the bundle-cache window before the
 *     edge function is switched (see the cutover runbook), which is also what removes the
 *     cross-version dedup overlap. Current bundles never emit this shape for a year crossing.
 *
 * Returns null for ANY deviation; there is deliberately no fuzzy matching.
 */
export function parseLegacyDateRange(value: string): { from: string; to: string } | null {
  const v = value.trim();
  const pad = (n: string) => n.padStart(2, "0");
  const iso = (year: string, mon: number, day: string) => `${year}-${pad(String(mon))}-${pad(day)}`;

  const explicit = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4}) - ([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/.exec(v);
  if (explicit) {
    const [, fromMon, fromDay, fromYear, toMon, toDay, toYear] = explicit;
    const fm = LEGACY_MONTHS[fromMon];
    const tm = LEGACY_MONTHS[toMon];
    if (!fm || !tm) return null;
    const from = iso(fromYear, fm, fromDay);
    const to = iso(toYear, tm, toDay);
    if (!isIsoDate(from) || !isIsoDate(to)) return null;
    return { from, to };
  }

  const m = /^([A-Z][a-z]{2}) (\d{1,2}) - ([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/.exec(v);
  if (!m) return null;
  const [, fromMon, fromDay, toMon, toDay, year] = m;
  const fm = LEGACY_MONTHS[fromMon];
  const tm = LEGACY_MONTHS[toMon];
  if (!fm || !tm) return null;
  const to = iso(year, tm, toDay);
  // Smallest non-negative span: the printed year unless that inverts the range, in which case
  // the left end belongs to the year before. Comparing whole ISO dates (not months) is what
  // makes a same-month crossing such as "Jan 10 - Jan 2, 2027" resolve instead of being dropped.
  let from = iso(year, fm, fromDay);
  if (from > to) from = iso(String(Number(year) - 1), fm, fromDay);
  if (!isIsoDate(from) || !isIsoDate(to)) return null;
  return { from, to };
}

export type NotifyRequest =
  | {
    subtype: "new_availability";
    slotCount: number;
    dateFrom: string;
    dateTo: string;
    /**
     * The legacy display range EXACTLY as received, when the caller sent one. Used for one
     * thing only: reconstructing the pre-cutover dedup key during the deploy overlap. Keeping
     * the received string rather than re-deriving it guarantees the reconstructed key is
     * byte-identical to whatever the old handler would have claimed for this same request.
     */
    legacyRange?: string;
  }
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
  return {
    ok: true,
    req: {
      subtype: "new_availability",
      slotCount,
      dateFrom: b.date_from,
      dateTo: b.date_to,
      ...(typeof b.date_range === "string" ? { legacyRange: b.date_range } : {}),
    },
  };
}

/**
 * The PRE-CUTOVER dedup key for one recipient, or null when it cannot be reconstructed.
 *
 * WHY THIS EXISTS — the cutover has two independent dedup stores for as long as both handler
 * versions are reachable. The old handler claims `notification_sends`; the new one relies on the
 * resolver's `<event>:<subject>:<recipient>` idempotency key in `notification_outbox`. Neither
 * store knows about the other, so this sequence double-notifies a follower:
 *
 *   old handler sends -> the HTTP response is lost -> the client retries -> the deploy flips ->
 *   the new handler enqueues the same batch -> the follower is notified a second time.
 *
 * Matching the DATE semantics across versions does not help; the two versions simply do not read
 * the same ledger. So the new handler consults the legacy ledger for the transition window, and
 * records into it what it has handled, which makes exactly ONE notion of "already handled" apply
 * across the deploy in both directions (including a rollback to the old handler).
 *
 * The key is byte-for-byte what `20260614210000_notification_sends_dedup.sql` documents and what
 * the old handler built: `<trainer_id>:<player_id>:<anchor>`, anchor `na:<date_range display>` or
 * `sr:<booking_id>` falling back to `sr:<date>:<time>`. `playerId` is the PROFILE id, which is
 * what the old handler used — not the auth user id.
 *
 * Returns null when the request carries no legacy range at all, because there is then no string
 * the old handler could have keyed on and therefore nothing to reconcile against.
 *
 * REMOVE with the rest of the compatibility branch, one full rollout + cache window after cutover.
 */
export function legacyDedupKey(
  req: NotifyRequest,
  trainerId: string,
  playerId: string,
): string | null {
  if (!trainerId || !playerId) return null;
  if (req.subtype === "slot_reopened") {
    return `${trainerId}:${playerId}:sr:${req.bookingId ?? `${req.slotDate}:${req.slotTime}`}`;
  }
  if (!req.legacyRange) return null;
  return `${trainerId}:${playerId}:na:${req.legacyRange}`;
}

/**
 * A trusted self-continuation cursor.
 *
 * The run drains its own tail rather than depending on the caller to retry: a pre-cutover bundle
 * ignores a non-2xx entirely, so a deferred tail that only the client could resume was simply
 * lost. Nothing here widens trust — the trainer is still derived from the authenticated user on
 * every invocation, and these two fields only say WHERE to carry on and HOW MANY hops have been
 * taken, so a forged value can at worst skip a caller's own followers or stop the chain early.
 */
export type ResumeState = {
  afterPlayerId: string | null;
  depth: number;
  /**
   * True when the previous hop is REPEATING its own range because its first recipient failed.
   * It is what bounds the retry to one attempt: a hop that is already a retry and fails the same
   * way advances past the recipient instead of handing itself the same range again.
   */
  retrying: boolean;
};

export const MAX_CONTINUATION_DEPTH = 20;

export function parseResumeState(raw: unknown): ResumeState {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const after = isUuid(b.resume_after_player_id) ? b.resume_after_player_id : null;
  const rawDepth = b.continuation_depth;
  const depth = typeof rawDepth === "number" && Number.isInteger(rawDepth) && rawDepth > 0
    ? Math.min(rawDepth, MAX_CONTINUATION_DEPTH)
    : 0;
  return { afterPlayerId: after, depth, retrying: b.resume_retry === true };
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

// ===========================================================================
// RUN PROGRESS — the arithmetic that decides what is still owed, and to whom.
//
// These live here rather than inline in the handler for the same reason everything else does:
// the handler cannot be imported, and each of these rules has already been wrong once.
// ===========================================================================

/**
 * Where the next hop must carry on from. The cursor is EXCLUSIVE — discovery resumes at
 * `player_id > cursor` — and `null` legitimately means "from the beginning", not "nowhere".
 *
 *  * completed some but not all discovered recipients → the last one completed;
 *  * completed NONE of them → the cursor this hop was itself handed, which re-covers exactly
 *    the same range. That is the only way to retry a recipient that failed in first position:
 *    because the query is `> cursor`, no cursor exists strictly between it and its predecessor.
 *    (Returning null here instead was a real defect: on a resumed hop the incoming cursor is by
 *    construction absent from `recipientIds`, so a first-position failure produced a null cursor,
 *    the chain declined to continue, and an arbitrarily large tail was abandoned.)
 *  * completed all of them → the last follower id DISCOVERY read, which can be past the final
 *    recipient because followers without an account are discovered and then dropped.
 */
export function resumeCursorAfter(
  recipientIds: string[],
  completed: number,
  lastDiscovered: string | null,
  incomingCursor: string | null,
): string | null {
  if (completed >= recipientIds.length) return lastDiscovered;
  if (completed === 0) return incomingCursor;
  return recipientIds[completed - 1];
}

/**
 * What this run may honestly claim to have COMPLETED, and where the next hop resumes.
 *
 * Two rules, and the first one is the fix for a real leak:
 *
 *  * **A failure bounds completion.** A chunk is processed as a unit, so a single RPC failure
 *    used to be tallied while `processed` still advanced over the whole chunk. The cursor then
 *    pointed PAST a recipient nobody notified, and the continuation — which only looked at
 *    `deferred` — carried on with the tail and never came back. A caller that ignores the
 *    non-2xx (every pre-cutover bundle does) lost that follower silently. So completion stops at
 *    the first failure, and everything from there on is owed.
 *
 *  * **...but a failure may not stall the chain.** When the FIRST recipient of a hop fails,
 *    nothing was completed and the next hop can only re-cover the identical range. That is the
 *    retry — worth exactly one attempt for a transient RPC error. `retrying` says the hop it is
 *    planning for is ALREADY that retry, in which case the run steps over THAT recipient and
 *    reports it as `failed` rather than handing itself the same range until the hop cap.
 *    (Comparing the computed cursor to the incoming one cannot express this: discovery resumes
 *    at `player_id > cursor`, so the incoming cursor is never among `recipientIds`.)
 *
 *    It steps over exactly one recipient, not everything the hop touched. A retrying hop can get
 *    much further than the one that scheduled it, so a SECOND recipient failing for the first
 *    time is ordinary — and jumping to `processed` would carry the cursor past it, spending a
 *    retry it never had.
 *
 * `beyondDiscovery` is followers discovery never reached. `beyondUnknown` says the count of
 * those could not be READ: the run is then incomplete by construction, because reporting a
 * clean total from a failed count is exactly the fail-open that hides a tail.
 *
 * `repeating` tells the caller the continuation re-covers this hop's own range, so it must mark
 * that hop as the retry.
 */
export function planRunOutcome(args: {
  recipientIds: string[];
  processed: number;
  /** Indices (into recipientIds) of every recipient this hop failed to enqueue, ascending. */
  failureIndices: number[];
  beyondDiscovery: number;
  beyondUnknown: boolean;
  lastDiscovered: string | null;
  incomingCursor: string | null;
  retrying: boolean;
}): { deferred: number; nextCursor: string | null; incomplete: boolean; repeating: boolean } {
  const total = args.recipientIds.length;
  const processed = Math.min(Math.max(args.processed, 0), total);
  const failures = [...args.failureIndices].filter((n) => n >= 0).sort((a, b) => a - b);

  // A hop that is ALREADY the retry has spent the one attempt owed to the recipient it resumed
  // at, so that recipient — and ONLY that recipient — is stepped over. Advancing all the way to
  // `processed` instead would step over recipients that failed for the FIRST time later in the
  // same hop, and they would never be retried at all: a hop can process much further than the
  // one that scheduled it, so a second, unrelated failure is entirely normal here.
  const spent = args.retrying && failures[0] === 0;
  const remaining = spent ? failures.slice(1) : failures;
  const bounded = remaining.length > 0 ? Math.min(processed, remaining[0]) : processed;
  const completed = spent ? Math.max(bounded, Math.min(1, total)) : bounded;
  const repeating = completed === 0 && total > 0;
  const nextCursor = resumeCursorAfter(
    args.recipientIds,
    completed,
    args.lastDiscovered,
    args.incomingCursor,
  );

  const deferred = Math.max(total - completed, 0) + Math.max(args.beyondDiscovery, 0);
  return {
    deferred,
    nextCursor,
    repeating,
    incomplete: deferred > 0 || args.beyondUnknown || failures.length > 0,
  };
}

/**
 * Should this run chain a continuation of itself?
 *
 * The tail cannot be left to the CALLER. A pre-cutover bundle ignores a non-2xx response
 * entirely, and nothing re-invokes this route on a schedule, so work only the client could
 * resume was simply lost. Chaining is allowed only when the hop actually did something (at least
 * one chunk handled) and only within the hop bound, so a pathological run cannot spawn an
 * unbounded sequence of invocations. An unreadable remaining count also chains: not knowing the
 * size of the tail is not a reason to abandon it.
 *
 * The cursor is deliberately NOT a precondition. `null` means "resume from the beginning", which
 * is exactly what a first-position failure on the first hop must do; requiring a non-null cursor
 * is what abandoned that tail. Progress is guaranteed by planRunOutcome instead: a hop either
 * advances its cursor, or repeats its range once and is then forced past the failure.
 */
export function shouldContinue(
  args: {
    deferred: number;
    processed: number;
    depth: number;
    beyondUnknown?: boolean;
  },
): boolean {
  return (args.deferred > 0 || args.beyondUnknown === true)
    && args.processed > 0
    && args.depth < MAX_CONTINUATION_DEPTH;
}

/**
 * The legacy keys this run may record as handled.
 *
 * Recording into `notification_sends` is ONE-WAY on purpose. This run never READS that ledger to
 * skip anyone: a legacy row is a claim taken BEFORE the pre-cutover send, and the old handler
 * deleted it again when the send failed — so a surviving claim means "sent" OR "the invocation
 * died between claiming and sending", and a deploy is precisely what kills an in-flight
 * invocation. Treating that as "already notified" would drop a follower and still report the run
 * successful. Writing, by contrast, records something known: v2 has taken this recipient, so a
 * ROLLBACK to the old handler finds the key claimed and does not send a second copy.
 *
 * `failed` is never recorded — nobody notified that recipient, and claiming the key would
 * suppress the retry meant to reach them. That is the old handler's release-on-failure rule,
 * expressed as "never claim in the first place".
 */
export function markableLegacyKeys(
  results: Array<{ outcome: EnqueueOutcome; id: string }>,
  keys: Map<string, string>,
): string[] {
  const out: string[] = [];
  for (const r of results) {
    if (r.outcome === "failed") continue;
    const k = keys.get(r.id);
    if (k) out.push(k);
  }
  return out;
}
