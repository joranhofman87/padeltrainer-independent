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
 *
 * THE ONE DUPLICATION THAT REMAINS, and why it is not removable. `legacyDateRange` in
 * src/lib/notifyFollowers.ts produces the same string in the FRONTEND bundle. The two cannot be a
 * single module — the browser bundle and the Deno edge function share no import graph — and they
 * must not drift, because a drift means the two handler versions claim DIFFERENT legacy dedup
 * markers for one batch and a follower is mailed twice during the deploy overlap. So the pair is
 * pinned byte-for-byte by src/test/legacyDateRangeParity.test.ts, which imports both and compares
 * their output across same-year, cross-year, single-day, month/year rollover and leap-day ranges.
 * That test is the contract; do not edit either function without it.
 *
 * There is deliberately no SECOND copy inside this module. An earlier revision added a
 * `canonicalLegacyDateRange` twin here for the server-side derivation below — a duplicate of a
 * duplicate, in the same file, with nothing pinning it to the original.
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

/**
 * Upper bound on `slot_ids`. Deliberately generous for real UI batches (a 52-week cyclus is 52
 * ids) but finite: the array rides EVERY continuation hop, and an unbounded array would grow the
 * body up to MAX_CONTINUATION_DEPTH times. It is NOT a defence against PostgREST row caps — the
 * aggregate RPC is, because a scalar result cannot be truncated.
 */
export const MAX_SLOT_IDS = 500;

export type NotifyRequest =
  | {
    subtype: "new_availability";
    slotCount: number;
    dateFrom: string;
    dateTo: string;
    /** The exact inserted PUBLIC slot ids. Shape-validated here; PROVEN server-side by the RPC. */
    slotIds: string[];
    /**
     * The transitional legacy display range — DERIVED, never accepted.
     *
     * It used to be "the string exactly as received", and that is no longer what happens. This
     * value is now produced SERVER-SIDE by `formatLegacyDateRange(dateFrom, dateTo)` from the
     * structured ISO dates, so it exists for every `new_availability` request whether or not the
     * caller sent anything resembling it. A request carrying `date_range` does not supply this
     * field; it asserts it. The supplied string is compared BYTE-FOR-BYTE against the derived one
     * and a mismatch REFUSES the request — it is a consistency assertion about which batch this
     * is, not an input, and two disagreeing answers mean the caller and the server are not talking
     * about the same batch.
     *
     * Deriving is what makes the value trustworthy AND still byte-identical to whatever the old
     * handler would have claimed: the frontend builds its `date_range` from the same ISO dates
     * with the same formatter (`legacyDateRange`, pinned by the parity test), so for any request
     * that is accepted at all, derived and received are provably the same string.
     *
     * Its ONE use is `legacyDedupKey` — the pre-cutover `notification_sends` marker that keeps a
     * follower from being notified twice across the frontend/edge deploy overlap. It is never
     * business truth: not membership, not occurrence, and not the date range any recipient reads.
     * It is REQUIRED rather than optional because the parser always produces it; the optionality
     * only ever described the old "if the caller happened to send one" behaviour.
     */
    legacyRange: string;
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
  // The legacy `date_range` -> ISO conversion is GONE for new_availability. It existed to keep an
  // older caller working, but slot_ids are now required, so such a caller cannot satisfy the
  // request anyway — leaving the conversion would be dead compatibility that reads as support.
  if (!isIsoDate(b.date_from)) return { ok: false, error: "date_from must be an ISO date (YYYY-MM-DD)" };
  if (!isIsoDate(b.date_to)) return { ok: false, error: "date_to must be an ISO date (YYYY-MM-DD)" };
  if (b.date_to < b.date_from) return { ok: false, error: "date_to must not precede date_from" };

  // EXACT PROVENANCE, REQUIRED. The occurrence used to come from a date-range lookup with
  // offsetless literals against a timestamptz column — an off-by-one at day boundaries, and a
  // query that could match slots this caller never created. These ids identify the exact rows.
  //
  // Nothing here is authority: the handler re-derives the trainer from the JWT and proves every id
  // through an aggregate RPC. This is shape validation only, and it fails CLOSED.
  const rawIds = b.slot_ids;
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    return { ok: false, error: "slot_ids must be a non-empty array of slot uuids" };
  }
  if (rawIds.length > MAX_SLOT_IDS) {
    return { ok: false, error: `slot_ids must contain at most ${MAX_SLOT_IDS} ids` };
  }
  // STRUCTURE AND CASE ARE TWO QUESTIONS, ANSWERED SEPARATELY.
  //
  // `isUuid` is the module's one uuid test and it is deliberately case-insensitive: it answers
  // "is this the shape of a uuid", and it is stricter than a plain hex-and-dashes pattern —
  // it also pins the RFC version and variant nibbles. Every id this route can legitimately see is
  // an `availability_slots.id`, whose default is `gen_random_uuid()` (v4), so nothing real is
  // excluded by that strictness. Re-declaring a looser local regex here, as an earlier revision
  // did, would have been a SECOND uuid definition that quietly accepted values the rest of the
  // module rejects.
  //
  // The lowercase requirement is then checked ON TOP, and it is not cosmetic. The duplicate test
  // below compares STRINGS; `supplied_distinct_count` in the validation RPC compares UUID VALUES.
  // Postgres parses `A1B2…` and `a1b2…` to one uuid, JavaScript's Set sees two. Left unconstrained,
  // the edge and the database would be counting with different notions of "distinct", and a batch
  // submitting one slot twice in two cases would pass this check with N and come back matched N-1
  // — reported as "an id does not exist", which is a true refusal for an untrue reason. Requiring
  // the canonical lowercase form makes string equality and uuid equality the same relation, so
  // both sides count the same thing. It is REJECTED rather than normalized because every real
  // producer (PostgREST output, `crypto.randomUUID()`) already emits lowercase: a mixed-case id
  // means something upstream is not what this handler thinks it is, and that is worth a 400.
  const ids: string[] = [];
  for (const id of rawIds) {
    if (!isUuid(id)) {
      return { ok: false, error: "slot_ids must contain only uuid strings" };
    }
    if (id !== id.toLowerCase()) {
      return { ok: false, error: "slot_ids must contain only lowercase canonical uuids" };
    }
    ids.push(id);
  }
  // DUPLICATES ARE REJECTED, NOT NORMALIZED. Silently de-duplicating would make the handler's
  // "distinct count == submitted count" proof tautological, so a request repeating one id could
  // claim to cover a batch it never identified.
  if (new Set(ids).size !== ids.length) {
    return { ok: false, error: "slot_ids must not contain duplicates" };
  }
  // slot_count MUST DESCRIBE THIS BATCH — it is not an independent number the caller may pick.
  //
  // It reaches the recipient: the renderer prints "N new slots" from it, and the digest item is
  // immutable and hash-covered once formed. A caller that sends 40 ids and slot_count 200 would
  // therefore mail a figure no row supports, and the all-or-nothing id proof would not catch it —
  // that proof is about the ids. With duplicates already rejected, `ids.length` IS the size of the
  // batch, so this equality is the whole of the constraint. The handler additionally re-derives
  // the count from the RPC's `public_owned_count` and refuses on disagreement, so the number the
  // recipient reads is one the database vouched for rather than one the client asserted.
  if (slotCount !== ids.length) {
    return { ok: false, error: "slot_count must equal the number of slot_ids" };
  }

  // THE TRANSITIONAL LEGACY DEDUP MARKER, derived — never accepted.
  //
  // The pre-cutover handler keys `notification_sends` on a display range, so during the
  // frontend/edge deploy overlap both versions must claim the SAME marker or a recipient can be
  // sent to twice. The range is therefore derived here from the structured ISO dates with the same
  // canonical formatter the client uses. A `date_range` in the request is accepted ONLY as a
  // consistency assertion: it must match byte-for-byte, and a mismatch is refused rather than
  // reconciled, because two disagreeing ranges mean the caller and the server disagree about which
  // batch this is. A `date_range`-ONLY request is never converted — slot_ids are required above, so
  // such a caller cannot identify a batch at all and fails closed with nothing enqueued.
  //
  // The formatter is `formatLegacyDateRange` — this module's ONE definition of that string, the
  // function `parseLegacyDateRange` is the inverse of, and the one pinned byte-for-byte to the
  // frontend's `legacyDateRange` by src/test/legacyDateRangeParity.test.ts. That parity is what
  // makes "derived" and "what the old handler would have claimed" the same value.
  const legacyRange = formatLegacyDateRange(b.date_from, b.date_to);
  if (b.date_range !== undefined && b.date_range !== null) {
    if (typeof b.date_range !== "string" || b.date_range !== legacyRange) {
      return { ok: false, error: "date_range does not match the canonical range derived from date_from/date_to" };
    }
  }

  return {
    ok: true,
    req: {
      subtype: "new_availability",
      slotCount,
      dateFrom: b.date_from,
      dateTo: b.date_to,
      slotIds: ids,
      legacyRange,
    },
  };
}

// ===========================================================================
// SERVER-SIDE BATCH AUTHORITY — what the DATABASE says this batch is.
//
// parseNotifyRequest above validates SHAPE. Nothing it accepts is trusted as fact: the ids are
// well-formed, the dates are well-formed, and that is all a body can ever establish. Everything
// below turns the single scalar row from `notif_open_slots_validate_batch` into the values the run
// actually uses — the count the recipient reads, the range the idempotency subject is built from,
// and the occurrence the activation boundary is measured against.
// ===========================================================================

/**
 * The validation RPC's one row. `min_start_date`/`max_start_date` are CALENDAR DATES already —
 * computed inside the database as `(start_time AT TIME ZONE <trainer tz>)::date`, not timestamps
 * for the edge to convert. That is deliberate: a timestamptz becomes a calendar date only under
 * some timezone, doing that conversion in JavaScript would re-introduce the day-boundary off-by-one
 * this whole correction removes, and the trainer's own `trainer_profiles.timezone` is the only
 * defensible answer to "which day is this slot on".
 */
export type BatchValidationRow = {
  supplied_distinct_count: number;
  matched_count: number;
  public_owned_count: number;
  max_created_at: string | null;
  min_start_date: string | null;
  max_start_date: string | null;
};

export type BatchDecision =
  | {
    ok: true;
    /** Authoritative, from `public_owned_count` — never the client's `slot_count`. */
    slotCount: number;
    /** Authoritative, from `min_start_date` in the trainer's timezone. */
    dateFrom: string;
    /** Authoritative, from `max_start_date` in the trainer's timezone. */
    dateTo: string;
    /** Authoritative occurrence, from `max_created_at` over the owned public rows. */
    occurredAt: string;
    /** Re-derived from the AUTHORITATIVE dates, so the legacy marker follows the same authority. */
    legacyRange: string;
  }
  | { ok: false; error: string };

const isNonNegInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0;

/**
 * Decide whether a submitted batch may be announced, and on what terms.
 *
 * ALL-OR-NOTHING, AND NEVER A SUBSET. The three counts are only meaningful together:
 * `supplied_distinct == matched == public_owned == the number of ids submitted`. Any inequality
 * means the submitted set is not wholly the caller's own public slots, and the ONLY correct answer
 * is to refuse the whole request. Trimming to the ids that did validate is the failure this
 * function exists to prevent: the operator asked to announce a batch, and announcing a different,
 * smaller batch while reporting success is worse than announcing nothing.
 *
 * Each inequality is reported distinctly because they mean genuinely different things to whoever
 * reads the log — a missing id is usually a slot deleted between creation and this call, a
 * non-owned id is either a private slot of the caller's own or a foreign one, and a distinct-count
 * disagreement means the edge and the database counted the set differently at all (which the
 * lowercase-canonical rule in the parser is what rules out).
 *
 * THE CLIENT'S VALUES ARE COMPATIBILITY INPUTS, NOT AUTHORITY. `slot_count`, `date_from` and
 * `date_to` still arrive — the frontend deploys before the edge function, so a new bundle must
 * keep speaking to the old handler — and every one of them is checked against what the database
 * says rather than used. A disagreement REFUSES rather than reconciles, because the date range is
 * the idempotency subject: two versions of "which batch is this" produce two subjects, and two
 * subjects mean the same followers can be notified twice.
 *
 * Returns the DERIVED values, so the caller never has to decide which source won.
 */
export function decideBatch(
  req: Extract<NotifyRequest, { subtype: "new_availability" }>,
  data: unknown,
): BatchDecision {
  // A TABLE-returning function with an ungrouped aggregate yields exactly ONE row, always — for a
  // thousand ids, for none. Zero or several means we are not talking to the function we think we
  // are (a signature change, a stale schema cache, a rewrite that started returning slots), and
  // that is a refusal rather than something to take the first element of.
  const rows = Array.isArray(data) ? data : (data === null || data === undefined ? [] : [data]);
  if (rows.length !== 1 || rows[0] === null || typeof rows[0] !== "object") {
    return { ok: false, error: "slot batch validation did not return exactly one result row" };
  }
  const r = rows[0] as Record<string, unknown>;

  if (!isNonNegInt(r.supplied_distinct_count) || !isNonNegInt(r.matched_count) || !isNonNegInt(r.public_owned_count)) {
    return { ok: false, error: "slot batch validation returned a malformed result" };
  }
  const expected = req.slotIds.length;
  if (r.supplied_distinct_count !== expected) {
    return {
      ok: false,
      error: `slot batch validation disagreed about the submitted set (${r.supplied_distinct_count} distinct of ${expected} submitted)`,
    };
  }
  if (r.matched_count !== expected) {
    return {
      ok: false,
      error: `${expected - r.matched_count} of ${expected} submitted slot(s) no longer exist`,
    };
  }
  if (r.public_owned_count !== expected) {
    return {
      ok: false,
      error: `${expected - r.public_owned_count} of ${expected} submitted slot(s) are not public slots of this trainer`,
    };
  }

  // OCCURRENCE, from the rows themselves. max(created_at) over the owned public subset — the
  // moment the announced availability became true. Not start_time (future, and the enqueue rejects
  // an occurrence more than a minute ahead), and emphatically not now() (which would launder a
  // delayed or replayed creation across the activation boundary). Unreadable means un-sent.
  const occurredAt = r.max_created_at;
  if (typeof occurredAt !== "string" || occurredAt.length === 0) {
    return { ok: false, error: "the availability's occurrence time could not be established" };
  }

  const dateFrom = r.min_start_date;
  const dateTo = r.max_start_date;
  if (!isIsoDate(dateFrom) || !isIsoDate(dateTo)) {
    return { ok: false, error: "slot batch validation returned no usable date range" };
  }
  if (dateTo < dateFrom) {
    return { ok: false, error: "slot batch validation returned an inverted date range" };
  }

  // THE COMPATIBILITY ASSERTIONS. Everything below compares a client value to a database value and
  // refuses on disagreement. None of them can be satisfied by adjusting the client value in place —
  // there is no reconciliation branch, deliberately.
  if (req.slotCount !== r.public_owned_count) {
    return {
      ok: false,
      error: `slot_count (${req.slotCount}) disagrees with the ${r.public_owned_count} validated slot(s)`,
    };
  }
  if (req.dateFrom !== dateFrom || req.dateTo !== dateTo) {
    return {
      ok: false,
      error:
        `the submitted date range (${req.dateFrom}..${req.dateTo}) disagrees with the validated slots (${dateFrom}..${dateTo})`,
    };
  }

  return {
    ok: true,
    slotCount: r.public_owned_count,
    dateFrom,
    dateTo,
    occurredAt,
    // Derived from the AUTHORITATIVE dates. Identical to the parser's value for any request that
    // gets this far — the equality above is what guarantees that — but sourced from the database
    // so the marker cannot outlive the authority it was supposed to follow.
    legacyRange: formatLegacyDateRange(dateFrom, dateTo),
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
 * THE RANGE IS DERIVED, SO THE ANCHOR IS ALWAYS AVAILABLE. `legacyRange` used to be "whatever the
 * caller happened to send", and an ISO-only request therefore produced NO key and no marker —
 * silently losing the cross-version protection for exactly the new-bundle-to-old-handler direction
 * it exists for. The parser now derives it from the structured dates for every `new_availability`
 * request, with the same formatter the frontend uses, so the key is always reconstructible and is
 * byte-identical to the one the old handler builds. The empty-string guard below is defensive
 * only — the type makes it unreachable from the parser — and it fails CLOSED: no marker at all is
 * recoverable (the worst case is one duplicate email on a rollback), whereas a marker built from
 * an empty anchor would collide every batch of that trainer onto one key and suppress real sends.
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
   * Recipients a PREVIOUS hop failed to enqueue, carried forward for exactly one more attempt.
   *
   * This is why the continuation cursor never has to crawl. Bounding the cursor at a failure —
   * so the next hop would re-cover it — conflated two jobs: draining the tail, and retrying a
   * recipient. Failures then cost one or two hops each, and enough of them exhausted the hop cap
   * before the undiscovered tail was ever reached. Here the cursor only ever measures progress,
   * and a retry is an explicit, identity-bound set. A recipient that arrived in this set and
   * failed again is NOT carried forward, which is what caps it at two attempts and guarantees
   * the set shrinks to empty.
   */
  retryPlayerIds: string[];
};

export const MAX_CONTINUATION_DEPTH = 20;

/**
 * How many failed recipients one hop may hand to the next.
 *
 * A set this size cannot starve discovery, because retries are processed LAST: the one chunk a
 * hop is guaranteed to run is always a discovery chunk, so the cursor advances every hop no
 * matter how many retries are owed. Whatever the budget does not reach is carried forward.
 *
 * Beyond it, the excess is reported rather than carried. That degrades those recipients from two
 * attempts to one; it does not lose the tail. The earlier design re-covered the hop's own range
 * on overflow, which sounds safer and is worse: a set of recipients that fails DETERMINISTICALLY
 * makes every hop reset to the same cursor, so the hop cap is spent re-attempting them and a
 * perfectly healthy tail of tens of thousands is never discovered at all. A large failure count
 * does not prove the failure is systemic.
 */
export const MAX_RETRY_CARRY = 500;

export function parseResumeState(raw: unknown): ResumeState {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const after = isUuid(b.resume_after_player_id) ? b.resume_after_player_id : null;
  const rawDepth = b.continuation_depth;
  const depth = typeof rawDepth === "number" && Number.isInteger(rawDepth) && rawDepth > 0
    ? Math.min(rawDepth, MAX_CONTINUATION_DEPTH)
    : 0;
  const rawRetry = Array.isArray(b.resume_retry_player_ids) ? b.resume_retry_player_ids : [];
  const retryPlayerIds = [...new Set(rawRetry.filter(isUuid))].slice(0, MAX_RETRY_CARRY);
  return { afterPlayerId: after, depth, retryPlayerIds };
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
 *  * processed some but not all discovered recipients → the last one processed;
 *  * processed NONE of them → the cursor this hop was itself handed, so the next hop re-covers
 *    exactly the same range. Because the query is `> cursor`, no cursor exists strictly between
 *    a recipient and its predecessor, so this is the only way to express "start here again".
 *    DEFENSIVE only: discovery is processed first and the first chunk always runs, so a hop with
 *    a non-empty discovery set cannot currently reach it. It stays because it is the correct
 *    answer if that ever changes, not because production exercises it.
 *  * completed all of them → the last follower id DISCOVERY read, which can be past the final
 *    recipient because followers without an account are discovered and then dropped.
 */
export function resumeCursorAfter(
  recipientIds: string[],
  processed: number,
  lastDiscovered: string | null,
  incomingCursor: string | null,
): string | null {
  if (processed >= recipientIds.length) return lastDiscovered;
  if (processed === 0) return incomingCursor;
  return recipientIds[processed - 1];
}

/**
 * What this run owes, and where the next hop picks up.
 *
 * TWO SEPARATE JOBS, deliberately kept separate — conflating them is what produced three rounds
 * of defects. The CURSOR measures progress through discovered followers and nothing else, so it
 * advances monotonically and the tail always drains. A FAILED recipient is owed a retry, and that
 * is expressed as an explicit set of ids handed to the next hop.
 *
 * Only FRESH failures are carried: a recipient that arrived in this hop's retry set and failed
 * again is not handed on. That bounds every recipient to two attempts regardless of where in the
 * run it sat, and binds the retry to an identity rather than to a position, so an unfollow
 * between hops cannot spend someone else's attempt. A retry the hop never REACHED is different
 * from one that failed — it has not had its attempt yet, so it is carried on rather than quietly
 * discarded.
 *
 * TERMINATION comes from the CURSOR and the hop cap, not from the retry set shrinking. Retries
 * are processed last, so a hop whose discovery work fills the budget carries the same set on
 * unchanged; what it cannot do is stand still, because the cursor advances every hop. Once
 * discovery is exhausted the hops are all retries and the set does drain — and if the hop cap
 * arrives first, the survivors are reported as `deferred` rather than silently forgotten. The
 * retry set and the tail are bounded by the same cap, so neither can starve the other.
 *
 * `beyondDiscovery` is followers discovery never reached. `beyondUnknown` says the count of those
 * could not be READ: the run is then incomplete by construction, because reporting a clean total
 * from a failed count is exactly the fail-open that hides a tail.
 */
/**
 * Split what a hop actually got through into "discovered" and "retries not reached".
 *
 * Small, and load-bearing: the recipient list is `[...discovered, ...retries]` and the chunk loop
 * reports ONE number for how far it got, so this is the arithmetic that decides both where the
 * cursor lands and which retries are still owed. Getting it wrong by one term silently spends a
 * second attempt that never happened — and it lives here, not inline in the handler, precisely so
 * the suite exercises it instead of injecting its already-computed answer.
 */
export function splitProcessed(
  args: { discoveredCount: number; retryIds: string[]; processed: number },
): { processedDiscovered: number; unprocessedRetryIds: string[] } {
  const processed = Math.max(args.processed, 0);
  return {
    processedDiscovered: Math.min(processed, args.discoveredCount),
    unprocessedRetryIds: args.retryIds.slice(Math.max(processed - args.discoveredCount, 0)),
  };
}

export function planRunOutcome(args: {
  /** Discovered (non-retry) recipients, in cursor order. */
  discoveredIds: string[];
  /** How many of those this hop got through. */
  processedDiscovered: number;
  /** Ids this hop failed to enqueue that were NOT already retries. */
  freshFailureIds: string[];
  /**
   * Retry ids this hop never got to, because its wall-clock budget ran out before the retry
   * TAIL of the recipient list. They are still owed their second attempt, so they are carried on
   * — dropping them would silently spend an attempt that never happened.
   */
  unprocessedRetryIds: string[];
  /** True when any recipient at all failed, retries included. */
  anyFailure: boolean;
  beyondDiscovery: number;
  beyondUnknown: boolean;
  lastDiscovered: string | null;
  incomingCursor: string | null;
}): {
  deferred: number;
  nextCursor: string | null;
  retryIds: string[];
  /** Owed retries the hop could not carry. They got one attempt; the run reports them. */
  droppedRetries: number;
  incomplete: boolean;
} {
  const total = args.discoveredIds.length;
  const processed = Math.min(Math.max(args.processedDiscovered, 0), total);
  // Un-attempted retries come first: they have been owed the longest.
  const unique = [...new Set([...args.unprocessedRetryIds, ...args.freshFailureIds])];

  // OVERFLOW: more owed retries than one hop may carry. The excess is reported, not carried —
  // those recipients get one attempt instead of two, and the run says so. The cursor still
  // advances, because holding it back is what abandons the tail (see MAX_RETRY_CARRY).
  const retryIds = unique.slice(0, MAX_RETRY_CARRY);
  const droppedRetries = unique.length - retryIds.length;

  const nextCursor = resumeCursorAfter(
    args.discoveredIds,
    processed,
    args.lastDiscovered,
    args.incomingCursor,
  );
  // Only work that will actually be attempted again is counted as deferred. The dropped ids are
  // already counted as `failed`; promising them a retry the chain will not make would be a
  // second lie on top of the first.
  const deferred = Math.max(total - processed, 0)
    + Math.max(args.beyondDiscovery, 0)
    + retryIds.length;

  return {
    deferred,
    nextCursor,
    retryIds,
    droppedRetries,
    incomplete: deferred > 0 || args.beyondUnknown || args.anyFailure || droppedRetries > 0,
  };
}

/**
 * Should this run chain a continuation of itself?
 *
 * The tail cannot be left to the CALLER. A pre-cutover bundle ignores a non-2xx response
 * entirely, and nothing re-invokes this route on a schedule, so work only the client could
 * resume was simply lost. Chaining is allowed only when the hop actually MOVED — it enqueued
 * someone, or at minimum read follower rows and so advanced its cursor — and only within the hop
 * bound, so a pathological run cannot spawn an unbounded sequence of invocations. An unreadable remaining count also chains: not knowing the
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
    /**
     * Did this hop move? Reading follower rows counts, even when none of them yielded a
     * deliverable recipient — the cursor has advanced past them, so the next hop starts
     * somewhere new. Requiring an ENQUEUE here was wrong: a page of followers whose profiles
     * carry no user_id enqueues nobody, and the chain stopped with the tail undiscovered.
     */
    madeProgress: boolean;
    depth: number;
    beyondUnknown?: boolean;
  },
): boolean {
  return (args.deferred > 0 || args.beyondUnknown === true)
    && args.madeProgress
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
    // ONLY an outcome that created a durable v2 row. `enqueued` and `skipped` both write one, so
    // v2 demonstrably owns that recipient and the old handler must not send again.
    //
    // `no_row` does NOT qualify, and the reason is the ambiguity documented on classifyEnqueue:
    // it means EITHER an idempotency conflict (a row already exists — marking would be right)
    // OR that the resolver emitted nothing at all: preference 'off', no deliverable contact, a
    // suppressed address. In the second case there is no v2 row, and the marker would suppress
    // the old handler too. That is a silent miss — the failure this design refuses to trade for.
    // A live example: a follower is 'off' at enqueue, later switches to 'instant', and a rollback
    // then finds a marker standing in for a row that never existed.
    //
    // `failed` obviously does not qualify: nobody notified that recipient at all.
    if (r.outcome !== "enqueued" && r.outcome !== "skipped") continue;
    const k = keys.get(r.id);
    if (k) out.push(k);
  }
  return out;
}
