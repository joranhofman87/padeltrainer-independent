// Deno tests for the PRODUCTION open-slots notify primitives.
//
// These import the real module notify-followers/index.ts imports — not a copy — so deleting a
// validation branch, changing the idempotency subject, or letting rendered copy into the payload
// breaks this suite. That is the point: the handler ends in `serve(handler)` and can never be
// imported, so every rule that matters was moved here to be testable.
import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import {
  classifyEnqueue,
  digestPayload,
  eventSubject,
  formatLegacyDateRange,
  isHhMm,
  isIsoDate,
  isUuid,
  deferredCount,
  legacyDedupKey,
  markableLegacyKeys,
  MAX_CONTINUATION_DEPTH,
  newCounts,
  partitionLegacyClaims,
  resumeCursorAfter,
  shouldContinue,
  parseLegacyDateRange,
  parseNotifyRequest,
  parseResumeState,
  tally,
} from "./open-slots-notify.ts";

const BASE = { slot_count: 3, date_from: "2026-08-10", date_to: "2026-08-16" };

// ---------------------------------------------------------------------------
Deno.test("ISO date validation rejects shape-valid but non-existent dates", () => {
  assertEquals(isIsoDate("2026-08-10"), true);
  assertEquals(isIsoDate("2026-02-30"), false, "Feb 30 matches the regex but is not a date");
  assertEquals(isIsoDate("2026-13-01"), false);
  assertEquals(isIsoDate("2026-8-10"), false, "unpadded month is not ISO");
  assertEquals(isIsoDate("10-08-2026"), false);
  assertEquals(isIsoDate("Aug 10 - Aug 16, 2026"), false, "the pre-cutover display range");
  assertEquals(isIsoDate(20260810), false);
  assertEquals(isIsoDate(null), false);
});

Deno.test("HH:MM validation is 24-hour and strict", () => {
  for (const ok of ["00:00", "09:30", "23:59"]) assertEquals(isHhMm(ok), true, ok);
  for (const bad of ["24:00", "9:30", "23:60", "0930", "09:30:00", ""]) {
    assertEquals(isHhMm(bad), false, bad);
  }
});

Deno.test("uuid validation", () => {
  assertEquals(isUuid("11111111-1111-4111-8111-111111111111"), true);
  assertEquals(isUuid("not-a-uuid"), false);
  assertEquals(isUuid(""), false);
});

// ---------------------------------------------------------------------------
Deno.test("parse: a valid new_availability request", () => {
  const r = parseNotifyRequest(BASE);
  assertEquals(r.ok, true);
  if (!r.ok) return;
  assertEquals(r.req, { subtype: "new_availability", slotCount: 3, dateFrom: "2026-08-10", dateTo: "2026-08-16" });
});

Deno.test("parse: a CACHED bundle's legacy date_range is converted, not dropped", () => {
  // Deploy overlap: the frontend deploys automatically and users hold cached bundles, so a
  // legacy body arrives at the new handler for a while. 400ing it would DROP the notification.
  const r = parseNotifyRequest({ slot_count: 3, date_range: "Aug 10 - Aug 16, 2026" });
  assertEquals(r.ok, true);
  if (!r.ok) return;
  // The received display string is RETAINED alongside the converted ISO dates: it is the only
  // thing that can reproduce the pre-cutover dedup key byte for byte during the deploy overlap.
  assertEquals(r.req, {
    subtype: "new_availability", slotCount: 3, dateFrom: "2026-08-10", dateTo: "2026-08-16",
    legacyRange: "Aug 10 - Aug 16, 2026",
  });
});

Deno.test("parse: a legacy range and its ISO equivalent yield the SAME subject", () => {
  // This is what makes the overlap duplicate-free: whichever bundle a user is running, the
  // idempotency subject is identical, so the resolver de-duplicates across the cutover.
  const T = "44444444-4444-4444-4444-444444444444";
  const legacy = parseNotifyRequest({ slot_count: 3, date_range: "Aug 10 - Aug 16, 2026" });
  const iso = parseNotifyRequest(BASE);
  if (!legacy.ok || !iso.ok) throw new Error("fixture");
  assertEquals(eventSubject(legacy.req, T), eventSubject(iso.req, T));
});

Deno.test("parse: only the EXACT legacy format is accepted — no fuzzy matching", () => {
  for (const bad of [
    "10 Aug - 16 Aug 2026", "Aug 10 to Aug 16, 2026", "Aug 10 - Aug 16",
    "Foo 10 - Aug 16, 2026", "Aug 32 - Aug 33, 2026", "Aug 10 - Feb 30, 2026",
    "", "   ", "<script>", "Aug 10 - Aug 16, 20260",
  ]) {
    const r = parseNotifyRequest({ slot_count: 3, date_range: bad });
    assertEquals(r.ok, false, `must refuse: ${bad}`);
    if (r.ok) return;
    assertEquals(r.error.includes("no longer accepted"), true);
  }
});

Deno.test("parse: an explicit ISO body WINS over any date_range also present", () => {
  const r = parseNotifyRequest({
    slot_count: 3, date_from: "2026-09-01", date_to: "2026-09-02",
    date_range: "Aug 10 - Aug 16, 2026",
  });
  assertEquals(r.ok, true);
  if (!r.ok) return;
  assertEquals((r.req as { dateFrom: string }).dateFrom, "2026-09-01");
});

Deno.test("parse: rejects bad slot_count rather than coercing", () => {
  for (const bad of [0, -1, 1.5, "3", null, undefined, 10001]) {
    const r = parseNotifyRequest({ ...BASE, slot_count: bad });
    assertEquals(r.ok, false, `slot_count ${bad} must be rejected`);
  }
});

Deno.test("parse: rejects an inverted range", () => {
  const r = parseNotifyRequest({ slot_count: 1, date_from: "2026-08-16", date_to: "2026-08-10" });
  assertEquals(r.ok, false);
  if (r.ok) return;
  assertEquals(r.error.includes("precede"), true);
});

Deno.test("parse: a valid slot_reopened request, with and without booking_id", () => {
  const withId = parseNotifyRequest({
    slot_count: 1, single_slot: { date: "2026-08-10", time: "18:30" },
    booking_id: "11111111-1111-4111-8111-111111111111",
  });
  assertEquals(withId.ok, true);
  if (withId.ok) {
    assertEquals(withId.req.subtype, "slot_reopened");
    assertEquals((withId.req as { bookingId?: string }).bookingId, "11111111-1111-4111-8111-111111111111");
  }

  const without = parseNotifyRequest({ slot_count: 1, single_slot: { date: "2026-08-10", time: "18:30" } });
  assertEquals(without.ok, true);
  if (without.ok) assertEquals((without.req as { bookingId?: string }).bookingId, undefined);
});

Deno.test("parse: rejects a malformed single_slot and a non-uuid booking_id", () => {
  assertEquals(parseNotifyRequest({ slot_count: 1, single_slot: { date: "2026-02-30", time: "18:30" } }).ok, false);
  assertEquals(parseNotifyRequest({ slot_count: 1, single_slot: { date: "2026-08-10", time: "25:00" } }).ok, false);
  assertEquals(parseNotifyRequest({ slot_count: 1, single_slot: "nope" }).ok, false);
  assertEquals(parseNotifyRequest({
    slot_count: 1, single_slot: { date: "2026-08-10", time: "18:30" }, booking_id: "abc",
  }).ok, false);
});

Deno.test("parse: rejects a non-object body", () => {
  for (const bad of [null, undefined, "x", 5, []]) {
    // an array IS an object; it simply has no valid slot_count, so it still fails
    assertEquals(parseNotifyRequest(bad).ok, false);
  }
});

// ---------------------------------------------------------------------------
Deno.test("subject: deterministic and derived from STRUCTURED fields only", () => {
  const a = parseNotifyRequest(BASE);
  const b = parseNotifyRequest({ ...BASE });
  if (!a.ok || !b.ok) throw new Error("fixture");
  assertEquals(eventSubject(a.req, "44444444-4444-4444-4444-444444444444"), eventSubject(b.req, "44444444-4444-4444-4444-444444444444"), "same input -> same subject");
  assertEquals(eventSubject(a.req, "44444444-4444-4444-4444-444444444444"), "na:44444444-4444-4444-4444-444444444444:2026-08-10:2026-08-16");
});

Deno.test("subject: a DIFFERENT range is a different event", () => {
  const one = parseNotifyRequest(BASE);
  const two = parseNotifyRequest({ ...BASE, date_to: "2026-08-17" });
  if (!one.ok || !two.ok) throw new Error("fixture");
  assertEquals(eventSubject(one.req, "44444444-4444-4444-4444-444444444444") === eventSubject(two.req, "44444444-4444-4444-4444-444444444444"), false);
});

Deno.test("subject: BJ-08 — a reopened slot keys on the booking id when present", () => {
  const withId = parseNotifyRequest({
    slot_count: 1, single_slot: { date: "2026-08-10", time: "18:30" },
    booking_id: "11111111-1111-4111-8111-111111111111",
  });
  const without = parseNotifyRequest({ slot_count: 1, single_slot: { date: "2026-08-10", time: "18:30" } });
  if (!withId.ok || !without.ok) throw new Error("fixture");
  assertEquals(eventSubject(withId.req, "44444444-4444-4444-4444-444444444444"), "sr:44444444-4444-4444-4444-444444444444:11111111-1111-4111-8111-111111111111");
  assertEquals(eventSubject(without.req, "44444444-4444-4444-4444-444444444444"), "sr:44444444-4444-4444-4444-444444444444:2026-08-10:18:30", "falls back to slot date/time");
  // Re-opening a RE-BOOKED slot is a genuinely distinct event and must notify again.
  const secondCancellation = parseNotifyRequest({
    slot_count: 1, single_slot: { date: "2026-08-10", time: "18:30" },
    booking_id: "22222222-2222-4222-8222-222222222222",
  });
  if (!secondCancellation.ok) throw new Error("fixture");
  assertEquals(eventSubject(withId.req, "44444444-4444-4444-4444-444444444444") === eventSubject(secondCancellation.req, "44444444-4444-4444-4444-444444444444"), false);
});

// ---------------------------------------------------------------------------
Deno.test("payload: carries STRUCTURED data only — no rendered copy", () => {
  const r = parseNotifyRequest(BASE);
  if (!r.ok) throw new Error("fixture");
  const p = digestPayload(r.req, "Coach Ana") as { subtype: string; data: Record<string, unknown> };
  assertEquals(p.subtype, "new_availability");
  assertEquals(p.data, { trainer_name: "Coach Ana", slot_count: 3, date_from: "2026-08-10", date_to: "2026-08-16" });
  // the renderer owns every recipient-visible string; the edge must never supply one
  for (const forbidden of ["title", "body", "html", "subject", "url"]) {
    assertEquals(forbidden in p.data, false, `payload must not carry ${forbidden}`);
    assertEquals(forbidden in p, false, `payload must not carry ${forbidden}`);
  }
});

Deno.test("payload: a reopened slot carries slot_date/slot_time, not a range", () => {
  const r = parseNotifyRequest({ slot_count: 1, single_slot: { date: "2026-08-10", time: "18:30" } });
  if (!r.ok) throw new Error("fixture");
  const p = digestPayload(r.req, "Coach Ana") as { data: Record<string, unknown> };
  assertEquals(p.data.slot_date, "2026-08-10");
  assertEquals(p.data.slot_time, "18:30");
  assertEquals("date_from" in p.data, false);
  // the renderer REJECTS these for slot_reopened (20261010100000) — sending them would make
  // every reopened event raise once the digest engine is enabled
  assertEquals("slot_count" in p.data, false);
  assertEquals("date_to" in p.data, false);
});

// ---------------------------------------------------------------------------
Deno.test("classify: zero rows is NO_ROW — ambiguous, never overstated as de-duplication", () => {
  // enqueue_notification returns a row per row it CREATED; a conflict returns none. That is
  // exactly what a retry looks like, and reporting it as failed would make retries look broken.
  assertEquals(classifyEnqueue([]), "no_row");
  assertEquals(classifyEnqueue(null), "no_row");
  assertEquals(classifyEnqueue(undefined), "no_row");
});

Deno.test("classify: a pending row is enqueued; an all-skipped result is skipped", () => {
  assertEquals(classifyEnqueue([{ status: "pending" }]), "enqueued");
  assertEquals(classifyEnqueue([{ status: "skipped" }]), "skipped");
  // engine-off (digest_engine_disabled) is a REAL auditable outcome, never "enqueued"
  assertEquals(classifyEnqueue([{ status: "skipped" }, { status: "skipped" }]), "skipped");
  // mixed channels: any live work counts as enqueued
  assertEquals(classifyEnqueue([{ status: "skipped" }, { status: "pending" }]), "enqueued");
});

Deno.test("counts: there is no `sent` — this route only enqueues", () => {
  const c = newCounts();
  assertEquals(Object.keys(c).sort(),
    ["already_sent_legacy", "deferred", "enqueued", "failed", "no_row", "skipped"]);
  assertEquals("sent" in c, false);
  tally(c, "enqueued"); tally(c, "enqueued"); tally(c, "skipped"); tally(c, "failed");
  assertEquals(c.enqueued, 2);
  assertEquals(c.skipped, 1);
  assertEquals(c.failed, 1);
  assertEquals(c.no_row, 0);
});

// ---------------------------------------------------------------------------
// MUTATION PINS — each reproduces a deletion the suite must not survive.

Deno.test("MUTANT: an ISO check that only tests the SHAPE accepts 2026-02-30", () => {
  const shapeOnly = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
  assertEquals(shapeOnly("2026-02-30"), true, "the mutant accepts an impossible date...");
  assertEquals(isIsoDate("2026-02-30"), false, "...production refuses it");
});

Deno.test("MUTANT: a subject built from display text re-notifies on a format change", () => {
  const displaySubject = (range: string) => `na:${range}`;
  const a = displaySubject("Aug 10 - Aug 16, 2026");
  const b = displaySubject("10 Aug - 16 Aug 2026");   // same dates, different formatting
  assertEquals(a === b, false, "the mutant mints a NEW event for identical dates — re-spam");

  const p1 = parseNotifyRequest(BASE);
  const p2 = parseNotifyRequest({ ...BASE });
  if (!p1.ok || !p2.ok) throw new Error("fixture");
  assertEquals(eventSubject(p1.req, "44444444-4444-4444-4444-444444444444"), eventSubject(p2.req, "44444444-4444-4444-4444-444444444444"), "production is format-independent");
});

Deno.test("MUTANT: classifying zero rows as failed makes every retry look broken", () => {
  const mutant = (rows: unknown[] | null) => (!rows || rows.length === 0 ? "failed" : "enqueued");
  assertEquals(mutant([]), "failed");
  assertEquals(classifyEnqueue([]), "no_row");
  assertEquals(mutant([]) === classifyEnqueue([]), false, "baseline and mutant must differ");
});

Deno.test("MUTANT: treating an all-skipped result as enqueued hides the engine-off outcome", () => {
  const mutant = (rows: Array<{ status?: string | null }>) => (rows.length > 0 ? "enqueued" : "no_row");
  const allSkipped = [{ status: "skipped" }];
  assertEquals(mutant(allSkipped), "enqueued", "the mutant reports work that never happened");
  assertEquals(classifyEnqueue(allSkipped), "skipped");
  assertEquals(mutant(allSkipped) === classifyEnqueue(allSkipped), false);
});

// The trainer name is the one free-text field that reaches the renderer. It must be passed
// through unaltered — the SQL renderer owns truncation and the unsafe-content refusal, and a
// second sanitiser here would diverge from it.
Deno.test("payload passes the trainer name through untouched", () => {
  const r = parseNotifyRequest(BASE);
  if (!r.ok) throw new Error("fixture");
  const long = "A".repeat(200);
  const p = digestPayload(r.req, long) as { data: Record<string, unknown> };
  assertEquals(p.data.trainer_name, long, "truncation belongs to the renderer, not the edge");
});

// ---------------------------------------------------------------------------
// P1 REGRESSION GUARDS from the slice-D review.

Deno.test("subject is TRAINER-SCOPED: two trainers, same dates, distinct events", () => {
  const r = parseNotifyRequest(BASE);
  if (!r.ok) throw new Error("fixture");
  const t1 = "44444444-4444-4444-4444-444444444444";
  const t2 = "55555555-5555-5555-5555-555555555555";
  // The resolver's key is event+subject+RECIPIENT and does NOT include the tenant, so without
  // the trainer here a player following both trainers would get only the first — the second
  // collapsing into a zero-row "already existing" and being lost. The legacy key included
  // trainer_id; dropping it was a regression.
  assertEquals(eventSubject(r.req, t1) === eventSubject(r.req, t2), false);
  assertEquals(eventSubject(r.req, t1).includes(t1), true);
});

Deno.test("subject: the reopened FALLBACK is trainer-scoped too", () => {
  const r = parseNotifyRequest({ slot_count: 1, single_slot: { date: "2026-08-10", time: "18:30" } });
  if (!r.ok) throw new Error("fixture");
  const a = eventSubject(r.req, "44444444-4444-4444-4444-444444444444");
  const b = eventSubject(r.req, "55555555-5555-5555-5555-555555555555");
  assertEquals(a === b, false, "no booking id means date/time is the anchor — it must still be scoped");
});

Deno.test("subject: a missing trainer id THROWS rather than minting a colliding key", () => {
  const r = parseNotifyRequest(BASE);
  if (!r.ok) throw new Error("fixture");
  let threw = false;
  try { eventSubject(r.req, ""); } catch { threw = true; }
  assertEquals(threw, true);
});

Deno.test("MUTANT: a fuzzy legacy parser would admit unvalidated display text", () => {
  const fuzzy = (v: string) => /(\w{3}) (\d+)/.test(v);   // "close enough" matching
  assertEquals(fuzzy("Foo 99 - Bar 88, 2026"), true, "the mutant accepts nonsense...");
  const r = parseNotifyRequest({ slot_count: 3, date_range: "Foo 99 - Bar 88, 2026" });
  assertEquals(r.ok, false, "...production refuses it");
});

// MUTANT: an unscoped subject loses the second trainer's notification.
Deno.test("MUTANT: dropping the trainer from the subject collides across trainers", () => {
  const r = parseNotifyRequest(BASE);
  if (!r.ok) throw new Error("fixture");
  const unscoped = (req: typeof r.req) =>
    req.subtype === "slot_reopened" ? "sr:x" : `na:${req.dateFrom}:${req.dateTo}`;
  assertEquals(unscoped(r.req), unscoped(r.req), "the mutant yields ONE key for both trainers...");
  assertEquals(
    eventSubject(r.req, "44444444-4444-4444-4444-444444444444")
      === eventSubject(r.req, "55555555-5555-5555-5555-555555555555"),
    false,
    "...production keeps them distinct",
  );
});

// MUTANT: including slot_count on a reopened slot is rejected by the SQL renderer.
Deno.test("MUTANT: a reopened payload carrying slot_count would raise in the renderer", () => {
  const r = parseNotifyRequest({ slot_count: 1, single_slot: { date: "2026-08-10", time: "18:30" } });
  if (!r.ok) throw new Error("fixture");
  const mutant = { trainer_name: "x", slot_count: 1, slot_date: "2026-08-10", slot_time: "18:30" };
  assertEquals("slot_count" in mutant, true, "the mutant sends a field the renderer forbids...");
  const p = digestPayload(r.req, "x") as { data: Record<string, unknown> };
  assertEquals("slot_count" in p.data, false, "...production omits it");
});

Deno.test("legacy parser: a YEAR-CROSSING batch is converted, not rejected", () => {
  // The legacy format prints the year only on the right. Applying it to both ends turned
  // "Dec 29 - Jan 5, 2027" into an inverted 2027-12-29..2027-01-05 and DROPPED the
  // notification — a real case for recurring slots created across New Year.
  const r = parseNotifyRequest({ slot_count: 4, date_range: "Dec 29 - Jan 5, 2027" });
  assertEquals(r.ok, true);
  if (!r.ok) return;
  assertEquals((r.req as { dateFrom: string; dateTo: string }).dateFrom, "2026-12-29");
  assertEquals((r.req as { dateFrom: string; dateTo: string }).dateTo, "2027-01-05");
});

Deno.test("MUTANT: applying the printed year to BOTH ends inverts a New Year range", () => {
  const mutant = { from: "2027-12-29", to: "2027-01-05" };
  assertEquals(mutant.to < mutant.from, true, "the mutant produces an inverted range...");
  const r = parseNotifyRequest({ slot_count: 4, date_range: "Dec 29 - Jan 5, 2027" });
  assertEquals(r.ok, true, "...production accepts it");
});

// ===========================================================================
// The legacy display format — the AMBIGUITY, and how it is closed.
// ===========================================================================

Deno.test("legacy parser: a same-MONTH year crossing resolves instead of being rejected", () => {
  // A 52-week series is reachable from the bulk-slot form, so 2026-01-10 -> 2027-01-02 is a real
  // batch. It prints "Jan 10 - Jan 2, 2027", where the months are EQUAL — a rollover test that
  // compares months only sees no crossing, applies 2027 to both ends and produces an inverted
  // range, which the ordering check then rejects. The notification was simply dropped.
  const r = parseNotifyRequest({ slot_count: 52, date_range: "Jan 10 - Jan 2, 2027" });
  assertEquals(r.ok, true);
  if (!r.ok) return;
  assertEquals((r.req as { dateFrom: string }).dateFrom, "2026-01-10");
  assertEquals((r.req as { dateTo: string }).dateTo, "2027-01-02");
});

Deno.test("legacy parser: the EXPLICIT two-year form is parsed with nothing inferred", () => {
  // This is what every current bundle emits for a year-crossing range, and it is the form that
  // makes the ambiguity unreachable going forward: both years are stated.
  const r = parseNotifyRequest({ slot_count: 9, date_range: "Jan 1, 2026 - Jan 2, 2027" });
  assertEquals(r.ok, true);
  if (!r.ok) return;
  assertEquals((r.req as { dateFrom: string }).dateFrom, "2026-01-01");
  assertEquals((r.req as { dateTo: string }).dateTo, "2027-01-02");
});

Deno.test("legacy parser: the two forms of the SAME multi-year range disagree — which is why the explicit one exists", () => {
  // The single-year form cannot express a span of a year or more: "Jan 1 - Jan 2, 2027" is what
  // BOTH 2027-01-01..2027-01-02 and 2026-01-01..2027-01-02 print. Stated as an executable fact
  // rather than left as a comment, so the limitation cannot be forgotten.
  const ambiguous = parseLegacyDateRange("Jan 1 - Jan 2, 2027");
  const explicit = parseLegacyDateRange("Jan 1, 2026 - Jan 2, 2027");
  assertEquals(ambiguous, { from: "2027-01-01", to: "2027-01-02" });
  assertEquals(explicit, { from: "2026-01-01", to: "2027-01-02" });
  assertEquals(ambiguous!.from === explicit!.from, false);
});

Deno.test("format: both years are printed exactly when they differ, and never otherwise", () => {
  assertEquals(formatLegacyDateRange("2026-08-10", "2026-08-16"), "Aug 10 - Aug 16, 2026");
  assertEquals(formatLegacyDateRange("2026-12-29", "2027-01-05"), "Dec 29, 2026 - Jan 5, 2027");
  assertEquals(formatLegacyDateRange("2026-01-01", "2027-01-02"), "Jan 1, 2026 - Jan 2, 2027");
});

Deno.test("format -> parse round-trips for every range shape, including the ones that used to break", () => {
  const cases = [
    ["2026-08-10", "2026-08-16"],   // same month
    ["2026-08-10", "2026-08-10"],   // single day
    ["2026-12-29", "2027-01-05"],   // New Year crossing
    ["2026-01-10", "2027-01-02"],   // 52 weeks, same month name
    ["2026-01-01", "2027-01-02"],   // strictly more than a year
    ["2026-01-01", "2029-12-31"],   // multi-year
  ];
  for (const [from, to] of cases) {
    const printed = formatLegacyDateRange(from, to);
    assertEquals(parseLegacyDateRange(printed), { from, to }, printed);
  }
});

Deno.test("MUTANT: printing only the right-hand year loses a multi-year range on the round trip", () => {
  const mutantPrinted = "Jan 1 - Jan 2, 2027";                 // what the old formatter emitted
  assertEquals(parseLegacyDateRange(mutantPrinted)!.from, "2027-01-01", "the mutant round-trips to the WRONG year...");
  const printed = formatLegacyDateRange("2026-01-01", "2027-01-02");
  assertEquals(parseLegacyDateRange(printed)!.from, "2026-01-01", "...production round-trips exactly");
});

// ===========================================================================
// Cross-version dedup during the deploy overlap.
// ===========================================================================

Deno.test("legacy dedup key reproduces the PRE-CUTOVER key byte for byte", () => {
  // The old handler built `${trainer_id}:${player_id}:na:${date_range}` and claimed it in
  // notification_sends before sending. If this reconstruction differs by a single character the
  // bridge never matches and the overlap double-notifies exactly as before.
  const r = parseNotifyRequest({ ...BASE, date_range: "Aug 10 - Aug 16, 2026" });
  if (!r.ok) throw new Error("fixture");
  assertEquals(
    legacyDedupKey(r.req, "trainer-1", "player-9"),
    "trainer-1:player-9:na:Aug 10 - Aug 16, 2026",
  );
});

Deno.test("legacy dedup key uses the RECEIVED range verbatim, not a re-derived one", () => {
  // Re-deriving would silently diverge from whatever the old handler actually claimed the moment
  // the display format changed — which it just did. Echoing the received string cannot diverge.
  const r = parseNotifyRequest({ slot_count: 1, date_range: "Dec 29 - Jan 5, 2027" });
  if (!r.ok) throw new Error("fixture");
  assertEquals(legacyDedupKey(r.req, "t", "p"), "t:p:na:Dec 29 - Jan 5, 2027");
  assertEquals((r.req as { dateFrom: string }).dateFrom, "2026-12-29", "and the ISO dates are still corrected");
});

Deno.test("legacy dedup key is null when no legacy range was sent — nothing to reconcile", () => {
  const r = parseNotifyRequest(BASE);
  if (!r.ok) throw new Error("fixture");
  assertEquals(legacyDedupKey(r.req, "t", "p"), null);
});

Deno.test("legacy dedup key: a reopened slot keys on the booking id, exactly as BJ-08 did", () => {
  const withBooking = parseNotifyRequest({
    slot_count: 1,
    single_slot: { date: "2026-08-10", time: "18:30" },
    booking_id: "11111111-1111-4111-8111-111111111111",
  });
  const without = parseNotifyRequest({ slot_count: 1, single_slot: { date: "2026-08-10", time: "18:30" } });
  if (!withBooking.ok || !without.ok) throw new Error("fixture");
  assertEquals(legacyDedupKey(withBooking.req, "t", "p"), "t:p:sr:11111111-1111-4111-8111-111111111111");
  assertEquals(legacyDedupKey(without.req, "t", "p"), "t:p:sr:2026-08-10:18:30");
});

Deno.test("legacy dedup key requires BOTH the trainer and the player — no cross-tenant collapse", () => {
  const r = parseNotifyRequest({ ...BASE, date_range: "Aug 10 - Aug 16, 2026" });
  if (!r.ok) throw new Error("fixture");
  assertEquals(legacyDedupKey(r.req, "", "p"), null);
  assertEquals(legacyDedupKey(r.req, "t", ""), null);
  const a = legacyDedupKey(r.req, "trainer-a", "p");
  const b = legacyDedupKey(r.req, "trainer-b", "p");
  assertEquals(a === b, false, "two trainers publishing the same dates are different events");
});

Deno.test("MUTANT: a bridge key missing the anchor prefix cannot match a legacy claim", () => {
  const r = parseNotifyRequest({ ...BASE, date_range: "Aug 10 - Aug 16, 2026" });
  if (!r.ok) throw new Error("fixture");
  const mutant = `trainer-1:player-9:${(r.req as { legacyRange?: string }).legacyRange}`;
  assertEquals(mutant.includes(":na:"), false, "the mutant drops the anchor...");
  assertEquals(legacyDedupKey(r.req, "trainer-1", "player-9")!.includes(":na:"), true, "...production keeps it");
});

// ===========================================================================
// The continuation cursor.
// ===========================================================================

Deno.test("resume state: absent, malformed and hostile values all fall back to a fresh run", () => {
  assertEquals(parseResumeState(null), { afterPlayerId: null, depth: 0 });
  assertEquals(parseResumeState({}), { afterPlayerId: null, depth: 0 });
  assertEquals(parseResumeState({ resume_after_player_id: "not-a-uuid" }), { afterPlayerId: null, depth: 0 });
  assertEquals(parseResumeState({ resume_after_player_id: 42 }), { afterPlayerId: null, depth: 0 });
  assertEquals(parseResumeState({ continuation_depth: -5 }).depth, 0);
  assertEquals(parseResumeState({ continuation_depth: 1.5 }).depth, 0);
});

Deno.test("resume state: a valid cursor is carried and the hop count is CLAMPED", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  assertEquals(parseResumeState({ resume_after_player_id: id, continuation_depth: 3 }),
    { afterPlayerId: id, depth: 3 });
  assertEquals(
    parseResumeState({ continuation_depth: 10_000 }).depth,
    MAX_CONTINUATION_DEPTH,
    "an inflated hop count must not buy an unbounded chain",
  );
});

Deno.test("MUTANT: an unclamped hop count lets a forged body chain without bound", () => {
  const mutant = (raw: Record<string, unknown>) => Number(raw.continuation_depth);
  assertEquals(mutant({ continuation_depth: 10_000 }) < MAX_CONTINUATION_DEPTH, false);
  assertEquals(parseResumeState({ continuation_depth: 10_000 }).depth <= MAX_CONTINUATION_DEPTH, true);
});

Deno.test("counts: already_sent_legacy is its own bucket, never folded into enqueued", () => {
  const c = newCounts();
  assertEquals(c.already_sent_legacy, 0);
  tally(c, "already_sent_legacy");
  tally(c, "enqueued");
  assertEquals(c.already_sent_legacy, 1);
  assertEquals(c.enqueued, 1, "a follower the OLD handler already mailed was not enqueued by us");
  assertEquals("sent" in c, false);
});

// ===========================================================================
// Run progress: the exact, resumable ceiling.
// ===========================================================================

Deno.test("deferred is EXACT — nothing omitted means nothing deferred", () => {
  // The bug this replaces: `Math.max(total - collected, 1)` reported "1 deferred" when the run
  // had collected exactly the ceiling and there was in fact nothing left.
  assertEquals(deferredCount({ discovered: 20000, processed: 20000, beyondDiscovery: 0 }), 0);
  assertEquals(deferredCount({ discovered: 0, processed: 0, beyondDiscovery: 0 }), 0);
});

Deno.test("deferred counts the undiscovered tail as the NUMBER it is", () => {
  // ...and the other half of the same bug: 10000 omitted followers reported as "1".
  assertEquals(deferredCount({ discovered: 20000, processed: 20000, beyondDiscovery: 10000 }), 10000);
  assertEquals(deferredCount({ discovered: 500, processed: 120, beyondDiscovery: 40 }), 420);
});

Deno.test("MUTANT: a floored deferred count misreports both ends of the ceiling", () => {
  const mutant = (total: number, collected: number) => Math.max(total - collected, 1);
  assertEquals(mutant(20000, 20000), 1, "the mutant invents work that does not exist...");
  assertEquals(deferredCount({ discovered: 20000, processed: 20000, beyondDiscovery: 0 }), 0);
});

Deno.test("resume cursor: a partly processed run carries on from the LAST recipient handled", () => {
  assertEquals(resumeCursorAfter(["a", "b", "c", "d"], 2, "d"), "b");
});

Deno.test("resume cursor: a fully processed run carries on from the last DISCOVERED follower", () => {
  // Discovery reads followers; recipients drop the ones with no account. Resuming from the last
  // recipient would re-read those accountless followers on every hop.
  assertEquals(resumeCursorAfter(["a", "b"], 2, "z"), "z");
  assertEquals(resumeCursorAfter([], 0, "z"), "z");
});

Deno.test("resume cursor: nothing processed and nothing discovered yields NO cursor", () => {
  assertEquals(resumeCursorAfter(["a", "b"], 0, null), null);
});

Deno.test("continuation is taken only when it must, and can, make progress", () => {
  const base = { deferred: 5, processed: 10, nextCursor: "p", depth: 0 };
  assertEquals(shouldContinue(base), true);
  assertEquals(shouldContinue({ ...base, deferred: 0 }), false, "nothing owed");
  assertEquals(shouldContinue({ ...base, processed: 0 }), false, "no progress → the chain would spin");
  assertEquals(shouldContinue({ ...base, nextCursor: null }), false, "no cursor → the hop repeats itself");
  assertEquals(shouldContinue({ ...base, depth: MAX_CONTINUATION_DEPTH }), false, "hop bound reached");
  assertEquals(shouldContinue({ ...base, depth: MAX_CONTINUATION_DEPTH - 1 }), true);
});

Deno.test("MUTANT: chaining without a progress check spins on the same cursor for ever", () => {
  const mutant = (a: { deferred: number }) => a.deferred > 0;
  assertEquals(mutant({ deferred: 5 }), true, "the mutant chains with zero progress...");
  assertEquals(shouldContinue({ deferred: 5, processed: 0, nextCursor: "p", depth: 0 }), false);
});

// ===========================================================================
// The legacy bridge's two decisions.
// ===========================================================================

const CHUNK = [{ id: "p1" }, { id: "p2" }, { id: "p3" }];
const KEYS = new Map([["p1", "t:p1:na:R"], ["p2", "t:p2:na:R"], ["p3", "t:p3:na:R"]]);

Deno.test("a follower the OLD handler already mailed is NOT enqueued again", () => {
  const { toEnqueue, alreadySent } = partitionLegacyClaims(CHUNK, KEYS, new Set(["t:p2:na:R"]));
  assertEquals(toEnqueue.map((p) => p.id), ["p1", "p3"]);
  assertEquals(alreadySent.map((p) => p.id), ["p2"]);
});

Deno.test("with no legacy claims at all, everybody is enqueued", () => {
  const { toEnqueue, alreadySent } = partitionLegacyClaims(CHUNK, KEYS, new Set());
  assertEquals(toEnqueue.length, 3);
  assertEquals(alreadySent.length, 0);
});

Deno.test("a recipient with no legacy key is enqueued — there is nothing to reconcile", () => {
  const { toEnqueue } = partitionLegacyClaims(CHUNK, new Map(), new Set(["t:p2:na:R"]));
  assertEquals(toEnqueue.length, 3, "a stale claim must not suppress a recipient we cannot key");
});

Deno.test("MUTANT: ignoring the legacy ledger re-notifies everyone the old handler mailed", () => {
  const mutant = (chunk: typeof CHUNK) => ({ toEnqueue: chunk, alreadySent: [] });
  assertEquals(mutant(CHUNK).toEnqueue.length, 3, "the mutant enqueues the already-mailed follower...");
  assertEquals(partitionLegacyClaims(CHUNK, KEYS, new Set(["t:p2:na:R"])).toEnqueue.length, 2);
});

Deno.test("a FAILED recipient is never claimed in the legacy ledger", () => {
  // Claiming it would suppress the very retry that is meant to reach them — the same mistake the
  // old handler avoided by releasing a claim on send failure.
  const keys = markableLegacyKeys([
    { outcome: "enqueued", id: "p1" },
    { outcome: "failed", id: "p2" },
    { outcome: "skipped", id: "p3" },
  ], KEYS);
  assertEquals(keys, ["t:p1:na:R", "t:p3:na:R"]);
});

Deno.test("an already-claimed recipient is not re-claimed, and a keyless one is skipped", () => {
  assertEquals(markableLegacyKeys([{ outcome: "already_sent_legacy", id: "p1" }], KEYS), []);
  assertEquals(markableLegacyKeys([{ outcome: "enqueued", id: "p9" }], KEYS), []);
});

Deno.test("no_row is claimed: the resolver decided not to notify, which IS a decision", () => {
  // 'off', suppressed, no contact — the old handler would have reached the same conclusion, so a
  // rollback must not mail them either.
  assertEquals(markableLegacyKeys([{ outcome: "no_row", id: "p1" }], KEYS), ["t:p1:na:R"]);
});

Deno.test("MUTANT: claiming a FAILED recipient silently suppresses its retry", () => {
  const mutant = (rs: Array<{ id: string }>) => rs.map((r) => KEYS.get(r.id)!);
  assertEquals(mutant([{ id: "p2" }]).length, 1, "the mutant claims the failed recipient...");
  assertEquals(markableLegacyKeys([{ outcome: "failed", id: "p2" }], KEYS), []);
});
