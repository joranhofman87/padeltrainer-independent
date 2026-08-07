// Deno tests for the PRODUCTION open-slots notify primitives.
//
// These import the real module notify-followers/index.ts imports — not a copy — so deleting a
// validation branch, changing the idempotency subject, or letting rendered copy into the payload
// breaks this suite. That is the point: the handler ends in `serve(handler)` and can never be
// imported, so every rule that matters was moved here to be testable.
import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import {
  classifyEnqueue,
  decideBatch,
  digestPayload,
  eventSubject,
  formatLegacyDateRange,
  isHhMm,
  isIsoDate,
  isUuid,
  legacyDedupKey,
  markableLegacyKeys,
  MAX_CONTINUATION_DEPTH,
  MAX_RETRY_CARRY,
  MAX_SLOT_IDS,
  newCounts,
  type NotifyRequest,
  splitProcessed,
  planRunOutcome,
  shouldContinue,
  parseLegacyDateRange,
  parseNotifyRequest,
  parseResumeState,
  tally,
} from "./open-slots-notify.ts";

/** Three lowercase v4 uuids — the shape `availability_slots.id` (gen_random_uuid()) actually has. */
const IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];

// slot_count MATCHES the number of ids: that equality is now part of the contract, so a fixture
// that violated it would be testing a request the parser refuses outright.
const BASE = { slot_count: 3, date_from: "2026-08-10", date_to: "2026-08-16", slot_ids: IDS };

/** The RPC row for a batch that is wholly the trainer's own public slots. */
const okRow = (over: Record<string, unknown> = {}) => ({
  supplied_distinct_count: 3,
  matched_count: 3,
  public_owned_count: 3,
  max_created_at: "2026-08-07T09:15:00+00:00",
  min_start_date: "2026-08-10",
  max_start_date: "2026-08-16",
  ...over,
});

/** The parsed new_availability request for BASE, for feeding decideBatch. */
function baseReq(over: Record<string, unknown> = {}): Extract<NotifyRequest, { subtype: "new_availability" }> {
  const r = parseNotifyRequest({ ...BASE, ...over });
  if (!r.ok || r.req.subtype !== "new_availability") throw new Error(`fixture: ${r.ok ? "wrong subtype" : r.error}`);
  return r.req;
}

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
  assertEquals(r.req, {
    subtype: "new_availability",
    slotCount: 3,
    dateFrom: "2026-08-10",
    dateTo: "2026-08-16",
    slotIds: IDS,
    // DERIVED, not received: this body carried no date_range at all.
    legacyRange: "Aug 10 - Aug 16, 2026",
  });
});

Deno.test("parse: slot_ids are REQUIRED — a date_range-only body is refused, never converted", () => {
  // The legacy display range used to be CONVERTED back into ISO dates so a cached pre-cutover
  // bundle kept working. That conversion is gone, and its removal is deliberate: such a caller
  // cannot supply slot_ids, so it cannot identify the batch it is asking about, and the handler
  // has nothing to prove against the database. Accepting it would be dead compatibility that
  // reads as support. It fails CLOSED — nothing is enqueued.
  const r = parseNotifyRequest({ slot_count: 3, date_range: "Aug 10 - Aug 16, 2026" });
  assertEquals(r.ok, false);
  if (r.ok) return;
  assertEquals(r.error.includes("date_from"), true, "it fails on the missing structured dates");
});

Deno.test("parse: an ISO body with no slot_ids at all is refused", () => {
  const { slot_ids: _drop, ...noIds } = BASE;
  const r = parseNotifyRequest(noIds);
  assertEquals(r.ok, false);
  if (r.ok) return;
  assertEquals(r.error.includes("slot_ids"), true);
});

Deno.test("parse: date_range is a byte-equality ASSERTION, not an input", () => {
  // A matching one is accepted and changes nothing — the derived value is used either way.
  const match = parseNotifyRequest({ ...BASE, date_range: "Aug 10 - Aug 16, 2026" });
  assertEquals(match.ok, true);
  if (!match.ok) return;
  assertEquals((match.req as { legacyRange: string }).legacyRange, "Aug 10 - Aug 16, 2026");

  // Anything else refuses. Two disagreeing answers to "which batch is this" is not something to
  // reconcile: the range is the dedup anchor, and picking one silently would key the two handler
  // versions differently and mail a follower twice.
  for (
    const bad of [
      "Aug 10 - Aug 17, 2026", // a real range, but not THIS one
      "10 Aug - 16 Aug 2026", // right dates, wrong format
      "Aug 10 - Aug 16, 2026 ", // trailing space: byte equality means byte equality
      "aug 10 - aug 16, 2026",
      "",
      "<script>",
      42,
      { toString: () => "Aug 10 - Aug 16, 2026" },
    ]
  ) {
    const r = parseNotifyRequest({ ...BASE, date_range: bad });
    assertEquals(r.ok, false, `must refuse date_range: ${JSON.stringify(bad)}`);
    if (r.ok) continue;
    assertEquals(r.error.includes("date_range"), true);
  }
});

Deno.test("parse: an explicit ISO body does NOT silently win over a disagreeing date_range", () => {
  // The old behaviour: ISO fields present -> date_range ignored. That let a caller ship two
  // different ranges in one body and be told it succeeded. It is now a refusal.
  const r = parseNotifyRequest({
    ...BASE,
    date_from: "2026-09-01",
    date_to: "2026-09-02",
    date_range: "Aug 10 - Aug 16, 2026",
  });
  assertEquals(r.ok, false);
  if (r.ok) return;
  assertEquals(r.error.includes("does not match"), true);
});

// ---------------------------------------------------------------------------
// slot_ids — shape validation. Nothing here is authority; it all fails CLOSED.

Deno.test("parse: slot_ids must be a NON-EMPTY array", () => {
  for (const bad of [[], "not-an-array", {}, null, 3]) {
    const r = parseNotifyRequest({ ...BASE, slot_ids: bad });
    assertEquals(r.ok, false, `must refuse slot_ids: ${JSON.stringify(bad)}`);
  }
});

Deno.test("parse: slot_ids is CAPPED — the array rides every continuation hop", () => {
  const many = Array.from({ length: MAX_SLOT_IDS + 1 }, (_, i) =>
    `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`);
  const r = parseNotifyRequest({ ...BASE, slot_count: many.length, slot_ids: many });
  assertEquals(r.ok, false);
  if (r.ok) return;
  assertEquals(r.error.includes(String(MAX_SLOT_IDS)), true);

  // Exactly at the cap is fine — the bound is inclusive.
  const atCap = many.slice(0, MAX_SLOT_IDS);
  assertEquals(parseNotifyRequest({ ...BASE, slot_count: MAX_SLOT_IDS, slot_ids: atCap }).ok, true);
});

Deno.test("parse: slot_ids must be STRUCTURALLY valid uuids — the module's one definition", () => {
  for (
    const bad of [
      "not-a-uuid",
      "11111111111141118111111111111111", // no dashes
      "11111111-1111-4111-8111-11111111111", // one short
      "11111111-1111-0111-8111-111111111111", // version nibble 0 — isUuid pins 1-5
      "11111111-1111-4111-c111-111111111111", // variant nibble c — isUuid pins 8/9/a/b
      "11111111-1111-4111-8111-111111111111 ",
      "",
      42,
      null,
      { id: "11111111-1111-4111-8111-111111111111" },
    ]
  ) {
    const r = parseNotifyRequest({ ...BASE, slot_count: 1, slot_ids: [bad] });
    assertEquals(r.ok, false, `must refuse slot id: ${JSON.stringify(bad)}`);
  }
});

Deno.test("parse: slot_ids must be LOWERCASE canonical — and here is why that is not cosmetic", () => {
  // A uuid with actual hex LETTERS — an all-digit one is unchanged by toUpperCase() and would
  // make this test vacuous.
  const lower = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const upper = lower.toUpperCase();
  assertEquals(lower === upper, false, "the fixture must actually change case");
  assertEquals(parseNotifyRequest({ ...BASE, slot_count: 1, slot_ids: [lower] }).ok, true, "lower is fine");
  // Structurally it IS a uuid: isUuid is case-insensitive on purpose.
  assertEquals(isUuid(upper), true, "the case rule is a SEPARATE question from the shape");

  const r = parseNotifyRequest({ ...BASE, slot_count: 1, slot_ids: [upper] });
  assertEquals(r.ok, false);
  if (r.ok) return;
  assertEquals(r.error.includes("lowercase"), true, "and it says so specifically");

  // THE REASON, stated as a test. The duplicate check compares STRINGS; the RPC's
  // supplied_distinct_count compares UUID VALUES. Postgres reads these two as ONE uuid:
  const mixedCaseSameUuid = [lower, upper];
  assertEquals(new Set(mixedCaseSameUuid).size, 2, "JavaScript sees two distinct strings...");
  // ...so without the lowercase rule this body would pass the JS duplicate check with 2, come
  // back from the database matched 1, and be reported as "an id does not exist" — a true refusal
  // for an untrue reason. Refusing the mixed case up front keeps both sides counting the same way.
  assertEquals(parseNotifyRequest({ ...BASE, slot_count: 2, slot_ids: mixedCaseSameUuid }).ok, false);
});

Deno.test("parse: DUPLICATE slot_ids are rejected, never normalized away", () => {
  // Normalizing would make the handler's "distinct == submitted" proof tautological: a body
  // repeating one id could then claim to cover a batch it never identified.
  const r = parseNotifyRequest({ ...BASE, slot_count: 3, slot_ids: [IDS[0], IDS[1], IDS[0]] });
  assertEquals(r.ok, false);
  if (r.ok) return;
  assertEquals(r.error.includes("duplicate"), true);
});

Deno.test("parse: slot_count must EQUAL the number of slot_ids", () => {
  // slot_count reaches the recipient — the renderer prints "N new slots" from it, into an
  // immutable hash-covered digest item. A caller sending 3 ids and slot_count 200 would mail a
  // figure no row supports, and the id proof would not catch it: that proof is about the ids.
  assertEquals(parseNotifyRequest({ ...BASE, slot_count: 2 }).ok, false, "fewer than the ids");
  assertEquals(parseNotifyRequest({ ...BASE, slot_count: 4 }).ok, false, "more than the ids");
  assertEquals(parseNotifyRequest({ ...BASE, slot_count: 200 }).ok, false, "wildly more");
  const r = parseNotifyRequest({ ...BASE, slot_count: 4 });
  if (r.ok) return;
  assertEquals(r.error.includes("slot_count"), true);
  // and the matching one is accepted
  assertEquals(parseNotifyRequest({ ...BASE, slot_count: 3 }).ok, true);
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
  assertEquals(Object.keys(c).sort(), ["deferred", "enqueued", "failed", "no_row", "skipped"]);
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
  // Production refuses it twice over now: there is no date_range -> ISO conversion at all, and
  // even alongside valid ISO dates a non-matching date_range is a refusal rather than an input.
  assertEquals(parseNotifyRequest({ slot_count: 3, date_range: "Foo 99 - Bar 88, 2026" }).ok, false);
  assertEquals(parseNotifyRequest({ ...BASE, date_range: "Foo 99 - Bar 88, 2026" }).ok, false);
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

// NOTE ON WHAT THESE NOW TEST. `parseLegacyDateRange` is no longer reachable through
// parseNotifyRequest — the date_range -> ISO conversion is gone, and a date_range-only body is
// refused. The function itself stays, because it is the INVERSE of formatLegacyDateRange and
// src/test/notifyFollowersRetry.test.ts round-trips the frontend's emitted string through it to
// prove the two formats still agree. So these exercise it directly, which is also more honest:
// they were always about the parser, not about request handling.

Deno.test("legacy parser: a YEAR-CROSSING batch is converted, not rejected", () => {
  // The legacy format prints the year only on the right. Applying it to both ends turned
  // "Dec 29 - Jan 5, 2027" into an inverted 2027-12-29..2027-01-05 and DROPPED the
  // notification — a real case for recurring slots created across New Year.
  assertEquals(parseLegacyDateRange("Dec 29 - Jan 5, 2027"), { from: "2026-12-29", to: "2027-01-05" });
});

Deno.test("MUTANT: applying the printed year to BOTH ends inverts a New Year range", () => {
  const mutant = { from: "2027-12-29", to: "2027-01-05" };
  assertEquals(mutant.to < mutant.from, true, "the mutant produces an inverted range...");
  const real = parseLegacyDateRange("Dec 29 - Jan 5, 2027")!;
  assertEquals(real.to > real.from, true, "...production resolves it to a forward range");
});

// ===========================================================================
// The legacy display format — the AMBIGUITY, and how it is closed.
// ===========================================================================

Deno.test("legacy parser: a same-MONTH year crossing resolves instead of being rejected", () => {
  // A 52-week series is reachable from the bulk-slot form, so 2026-01-10 -> 2027-01-02 is a real
  // batch. It prints "Jan 10 - Jan 2, 2027", where the months are EQUAL — a rollover test that
  // compares months only sees no crossing, applies 2027 to both ends and produces an inverted
  // range, which the ordering check then rejects. The notification was simply dropped.
  assertEquals(parseLegacyDateRange("Jan 10 - Jan 2, 2027"), { from: "2026-01-10", to: "2027-01-02" });
});

Deno.test("legacy parser: the EXPLICIT two-year form is parsed with nothing inferred", () => {
  // This is what every current bundle emits for a year-crossing range, and it is the form that
  // makes the ambiguity unreachable going forward: both years are stated.
  assertEquals(parseLegacyDateRange("Jan 1, 2026 - Jan 2, 2027"), { from: "2026-01-01", to: "2027-01-02" });
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

Deno.test("legacy dedup key uses the DERIVED range — and that is what makes it always available", () => {
  // It used to echo the RECEIVED string, on the reasoning that echoing cannot diverge from what
  // the old handler claimed. True, but it also meant an ISO-only body produced NO key at all —
  // losing the protection in exactly the new-bundle-to-old-handler direction it exists for.
  // Deriving with the same formatter the frontend uses (pinned byte-for-byte by
  // src/test/legacyDateRangeParity.test.ts) gets both: always available AND identical.
  const crossYear = baseReq({ date_from: "2026-12-29", date_to: "2027-01-05" });
  assertEquals(
    legacyDedupKey(crossYear, "t", "p"),
    "t:p:na:Dec 29, 2026 - Jan 5, 2027",
    "a year-crossing batch prints BOTH years — the unambiguous form",
  );
});

Deno.test("legacy dedup key is present for an ISO-only body — nothing to reconcile is no longer a case", () => {
  const r = parseNotifyRequest(BASE);
  if (!r.ok) throw new Error("fixture");
  assertEquals(legacyDedupKey(r.req, "t", "p"), "t:p:na:Aug 10 - Aug 16, 2026");
});

Deno.test("legacy dedup key: an EMPTY anchor yields null rather than a colliding key", () => {
  // Defensive: the type makes this unreachable from the parser. It fails CLOSED — no marker is a
  // recoverable weakness (at worst one duplicate email on a rollback), whereas a key built from an
  // empty anchor would collide every batch of that trainer onto one string and suppress real sends.
  const req = { ...baseReq(), legacyRange: "" };
  assertEquals(legacyDedupKey(req, "t", "p"), null);
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
  assertEquals(parseResumeState(null), { afterPlayerId: null, depth: 0, retryPlayerIds: [] });
  assertEquals(parseResumeState({}), { afterPlayerId: null, depth: 0, retryPlayerIds: [] });
  assertEquals(parseResumeState({ resume_after_player_id: "not-a-uuid" }),
    { afterPlayerId: null, depth: 0, retryPlayerIds: [] });
  assertEquals(parseResumeState({ resume_after_player_id: 42 }),
    { afterPlayerId: null, depth: 0, retryPlayerIds: [] });
  assertEquals(parseResumeState({ continuation_depth: -5 }).depth, 0);
  assertEquals(parseResumeState({ continuation_depth: 1.5 }).depth, 0);
});

Deno.test("resume state: a valid cursor is carried and the hop count is CLAMPED", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  assertEquals(parseResumeState({ resume_after_player_id: id, continuation_depth: 3 }),
    { afterPlayerId: id, depth: 3, retryPlayerIds: [] });
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


// ===========================================================================
// Run progress: the exact, resumable ceiling.
// ===========================================================================






// ===========================================================================
// The legacy bridge's two decisions.
// ===========================================================================

const CHUNK_KEYS = new Map([["p1", "t:p1:na:R"], ["p2", "t:p2:na:R"], ["p3", "t:p3:na:R"]]);

Deno.test("a FAILED recipient is never claimed in the legacy ledger", () => {
  // Claiming it would suppress the very retry that is meant to reach them — the same mistake the
  // old handler avoided by releasing a claim on send failure.
  const keys = markableLegacyKeys([
    { outcome: "enqueued", id: "p1" },
    { outcome: "failed", id: "p2" },
    { outcome: "skipped", id: "p3" },
  ], CHUNK_KEYS);
  assertEquals(keys, ["t:p1:na:R", "t:p3:na:R"]);
});

Deno.test("a recipient with no legacy key is skipped — there is nothing to record", () => {
  assertEquals(markableLegacyKeys([{ outcome: "enqueued", id: "p9" }], CHUNK_KEYS), []);
});



Deno.test("MUTANT: claiming a FAILED recipient silently suppresses its retry", () => {
  const mutant = (rs: Array<{ id: string }>) => rs.map((r) => CHUNK_KEYS.get(r.id)!);
  assertEquals(mutant([{ id: "p2" }]).length, 1, "the mutant claims the failed recipient...");
  assertEquals(markableLegacyKeys([{ outcome: "failed", id: "p2" }], CHUNK_KEYS), []);
});

// ===========================================================================
// Run progress: the cursor measures DISCOVERY, the retry set carries FAILURES.
// ===========================================================================

const UUID = (n: number) => `1111111${n}-1111-4111-8111-111111111111`;

const PLAN = {
  // Discovery resumes at `player_id > cursor`, so the incoming cursor is by construction NOT a
  // member of discoveredIds. An earlier fixture violated that and hid a defect for a whole round.
  discoveredIds: ["b", "c", "d", "e"],
  processedDiscovered: 4,   // a whole, small discovery set — the chunk loop got through it
  freshFailureIds: [] as string[],
  unprocessedRetryIds: [] as string[],
  anyFailure: false,
  beyondDiscovery: 0,
  beyondUnknown: false,
  lastDiscovered: "e",
  incomingCursor: null as string | null,
};

Deno.test("plan: a clean, complete run owes nothing", () => {
  assertEquals(planRunOutcome(PLAN), {
    deferred: 0, nextCursor: "e", retryIds: [], droppedRetries: 0, incomplete: false,
  });
});

Deno.test("plan: deferred is EXACT at the ceiling and for a real tail", () => {
  // The bug this replaces: `Math.max(total - collected, 1)` reported "1 deferred" when nothing
  // at all was omitted, and also "1" when tens of thousands were.
  assertEquals(planRunOutcome(PLAN).deferred, 0);
  assertEquals(planRunOutcome({ ...PLAN, beyondDiscovery: 10_000 }).deferred, 10_000);
  assertEquals(planRunOutcome({ ...PLAN, processedDiscovered: 2 }).deferred, 2);
});

Deno.test("plan: the cursor ADVANCES past a failure — draining the tail is not a failure's business", () => {
  // Bounding the cursor at a failure conflated two jobs. Failures then cost one or two hops each
  // and enough of them exhausted MAX_CONTINUATION_DEPTH before the undiscovered tail was reached,
  // which a caller that ignores the 500 never recovers from. The cursor now measures discovery
  // only, and the failed recipient is owed through an explicit set instead.
  const out = planRunOutcome({
    ...PLAN, freshFailureIds: ["c"], anyFailure: true, beyondDiscovery: 5000,
  });
  assertEquals(out.nextCursor, "e", "full progress, no crawl");
  assertEquals(out.retryIds, ["c"]);
  assertEquals(out.deferred, 5001, "the tail plus the one recipient owed a retry");
  assertEquals(out.incomplete, true);
});

Deno.test("plan: a recipient that ALREADY was a retry is not carried again — two attempts, hard stop", () => {
  // The handler only puts NON-retry failures in freshFailureIds, so a second failure ends there.
  const out = planRunOutcome({ ...PLAN, freshFailureIds: [], anyFailure: true });
  assertEquals(out.retryIds, []);
  assertEquals(out.deferred, 0, "nothing further is owed...");
  assertEquals(out.incomplete, true, "...but the run still reports the failure honestly");
});

Deno.test("plan: many failures do not slow the cursor down at all", () => {
  // The scenario that broke the previous design: 21 persistent failures early in the range
  // consumed the whole hop budget before the ceiling tail was reached.
  const ids = Array.from({ length: 30 }, (_, i) => `p${i}`);
  const out = planRunOutcome({
    ...PLAN,
    discoveredIds: ids,
    processedDiscovered: 30,
    lastDiscovered: "p29",
    freshFailureIds: ids.slice(0, 21),
    anyFailure: true,
    beyondDiscovery: 40_000,
  });
  assertEquals(out.nextCursor, "p29", "one hop, full progress");
  assertEquals(out.retryIds.length, 21);
  assertEquals(out.deferred, 40_021);
});

Deno.test("plan: beyond the carry cap the cursor STILL advances — the tail is never abandoned", () => {
  // The earlier design re-covered the hop's own range on overflow. That sounds safer and is
  // worse: a set of recipients that fails DETERMINISTICALLY resets every hop to the same cursor,
  // so the hop cap is spent re-attempting them and a healthy tail of tens of thousands is never
  // discovered at all. A large failure count does not prove the failure is systemic.
  const ids = Array.from({ length: MAX_RETRY_CARRY + 7 }, (_, i) => `p${i}`);
  const out = planRunOutcome({
    ...PLAN,
    discoveredIds: ids,
    processedDiscovered: ids.length,
    lastDiscovered: "pLast",
    freshFailureIds: ids,
    anyFailure: true,
    beyondDiscovery: 30_000,
    incomingCursor: "a",
  });
  assertEquals(out.nextCursor, "pLast", "full progress — the healthy tail is still reachable");
  assertEquals(out.retryIds.length, MAX_RETRY_CARRY);
  assertEquals(out.droppedRetries, 7, "reported, not silently forgotten");
  assertEquals(out.deferred, 30_000 + MAX_RETRY_CARRY, "only work that WILL be attempted again");
  assertEquals(out.incomplete, true);
});

Deno.test("MUTANT: holding the cursor on overflow spends the hop cap and loses the tail", () => {
  const ids = Array.from({ length: MAX_RETRY_CARRY + 7 }, (_, i) => `p${i}`);
  const mutantCursor = "a";                                  // re-cover the same range, for ever
  const out = planRunOutcome({
    ...PLAN, discoveredIds: ids, processedDiscovered: ids.length, lastDiscovered: "pLast",
    freshFailureIds: ids, anyFailure: true, beyondDiscovery: 30_000, incomingCursor: mutantCursor,
  });
  assertEquals(out.nextCursor === mutantCursor, false);
});

Deno.test("plan: exactly AT the cap is carried in full, with nothing dropped", () => {
  const ids = Array.from({ length: MAX_RETRY_CARRY }, (_, i) => `p${i}`);
  const out = planRunOutcome({
    ...PLAN, discoveredIds: ids, processedDiscovered: ids.length, lastDiscovered: "pLast",
    freshFailureIds: ids, anyFailure: true, incomingCursor: "a",
  });
  assertEquals(out.retryIds.length, MAX_RETRY_CARRY);
  assertEquals(out.droppedRetries, 0);
  assertEquals(out.nextCursor, "pLast");
});

Deno.test("plan: duplicate failure ids are collapsed", () => {
  const out = planRunOutcome({ ...PLAN, freshFailureIds: ["c", "c", "d"], anyFailure: true });
  assertEquals(out.retryIds, ["c", "d"]);
});

Deno.test("plan: an UNREADABLE remaining count keeps the run incomplete", () => {
  // Fail closed. `remainingCount ?? 0` turned a failed count into a clean 200 with no
  // continuation — and a pre-cutover caller never reads the body, so the tail was lost.
  const out = planRunOutcome({ ...PLAN, beyondUnknown: true });
  assertEquals(out.deferred, 0, "the size of the tail is genuinely unknown, so it is not invented");
  assertEquals(out.incomplete, true, "but the run must not report itself complete");
  assertEquals(shouldContinue({ deferred: 0, madeProgress: true, depth: 0, beyondUnknown: true }), true);
});

Deno.test("plan: a partly processed hop resumes from the last recipient it handled", () => {
  const out = planRunOutcome({ ...PLAN, processedDiscovered: 2 });
  assertEquals(out.nextCursor, "c");
});

Deno.test("plan: DEFENSIVE — zero discovered progress hands back the hop's own cursor", () => {
  // Deliberately labelled defensive: with discovery ordered FIRST and the first chunk always
  // running, the handler cannot currently produce this state for a non-empty discovery set. It is
  // still the only correct answer if it ever did — under an exclusive `> cursor` scan, re-sending
  // the incoming cursor is the only way to express "start here again" — so the branch stays and
  // says what it is, rather than being tested as though production reached it.
  assertEquals(planRunOutcome({ ...PLAN, processedDiscovered: 0, incomingCursor: "a" }).nextCursor, "a");
  assertEquals(planRunOutcome({ ...PLAN, processedDiscovered: 0, incomingCursor: null }).nextCursor, null);
});

Deno.test("plan: an EMPTY discovery set carries on from the last follower read", () => {
  const out = planRunOutcome({
    ...PLAN, discoveredIds: [], processedDiscovered: 0, lastDiscovered: "z", incomingCursor: "y",
  });
  assertEquals(out.nextCursor, "z");
  assertEquals(out.deferred, 0);
});

Deno.test("MUTANT: holding the cursor at a failure re-introduces the crawl", () => {
  const mutant = (ids: string[], firstFailure: number) => ids[firstFailure - 1] ?? null;
  assertEquals(mutant(PLAN.discoveredIds, 0), null, "the mutant stalls the cursor at index 0...");
  assertEquals(planRunOutcome({ ...PLAN, freshFailureIds: ["b"], anyFailure: true }).nextCursor, "e");
});

Deno.test("MUTANT: carrying a retry that already failed twice never terminates", () => {
  // Production only ever carries FRESH failures, so the set strictly shrinks.
  const out = planRunOutcome({ ...PLAN, freshFailureIds: [], anyFailure: true });
  assertEquals(out.retryIds.length, 0);
});

Deno.test("continuation is taken only when the hop MOVED and something is owed", () => {
  const base = { deferred: 5, madeProgress: true, depth: 0 };
  assertEquals(shouldContinue(base), true);
  assertEquals(shouldContinue({ ...base, deferred: 0 }), false, "nothing owed");
  assertEquals(shouldContinue({ ...base, madeProgress: false }), false, "did not move → it would spin");
  assertEquals(shouldContinue({ ...base, depth: MAX_CONTINUATION_DEPTH }), false, "hop bound reached");
  assertEquals(shouldContinue({ ...base, depth: MAX_CONTINUATION_DEPTH - 1 }), true);
});

Deno.test("continuation: reading follower rows IS progress, even with nobody deliverable", () => {
  // A page of followers whose profiles carry no user_id enqueues nobody, but the cursor has moved
  // past them. Requiring an ENQUEUE stopped the chain there and left the tail undiscovered — and
  // a pre-cutover caller never comes back for it.
  assertEquals(shouldContinue({ deferred: 0, madeProgress: true, depth: 0, beyondUnknown: true }), true);
  assertEquals(shouldContinue({ deferred: 900, madeProgress: true, depth: 0 }), true);
});

Deno.test("resume state: the retry set is uuid-filtered, de-duplicated and CAPPED", () => {
  const ids = [UUID(1), UUID(1), UUID(2), "not-a-uuid", 42];
  assertEquals(parseResumeState({ resume_retry_player_ids: ids }).retryPlayerIds, [UUID(1), UUID(2)]);
  assertEquals(parseResumeState({ resume_retry_player_ids: "nope" }).retryPlayerIds, []);
  const many = Array.from({ length: MAX_RETRY_CARRY + 50 }, (_, i) =>
    `1111111${(i % 10)}-1111-4111-8111-${String(i).padStart(12, "0")}`);
  assertEquals(parseResumeState({ resume_retry_player_ids: many }).retryPlayerIds.length, MAX_RETRY_CARRY);
});

Deno.test("MUTANT: an uncapped retry set lets a forged body drive an unbounded profile lookup", () => {
  const many = Array.from({ length: 5000 }, (_, i) =>
    `1111111${(i % 10)}-1111-4111-8111-${String(i).padStart(12, "0")}`);
  assertEquals(many.length > MAX_RETRY_CARRY, true, "the mutant would fetch all of them...");
  assertEquals(parseResumeState({ resume_retry_player_ids: many }).retryPlayerIds.length, MAX_RETRY_CARRY);
});

Deno.test("plan: a retry the hop never REACHED is carried on, not spent", () => {
  // Retries sit at the TAIL of the recipient list, so a budget that runs out before reaching them
  // leaves recipients that have had no second attempt at all. Carrying only fresh failures would
  // drop them: their retry would be recorded as spent when it never happened.
  //
  // The fixture respects the handler's ordering invariant: un-reached retries imply discovery was
  // worked through first, so a fresh failure among the discovered recipients is possible here —
  // under the previous retries-first ordering this same state was unreachable.
  // Chunk-realistic: 10 discovered recipients are exactly the one chunk a hop is guaranteed, so
  // the two retries behind them are genuinely un-reached when the budget then expires.
  const ids = Array.from({ length: 10 }, (_, i) => `d${i}`);
  const split = splitProcessed({ discoveredCount: 10, retryIds: ["r1", "r2"], processed: 10 });
  assertEquals(split.unprocessedRetryIds, ["r1", "r2"], "the handler's own arithmetic, not a stub");
  const out = planRunOutcome({
    ...PLAN, discoveredIds: ids, lastDiscovered: "d9",
    processedDiscovered: split.processedDiscovered,
    unprocessedRetryIds: split.unprocessedRetryIds, freshFailureIds: ["d3"], anyFailure: true,
  });
  assertEquals(out.retryIds, ["r1", "r2", "d3"], "un-attempted first — they have waited longest");
  assertEquals(out.deferred, 3, "everyone owed a retry; discovery itself is done");
});

Deno.test("plan: un-reached retries are carried even when NOTHING failed this hop", () => {
  // The case the previous fixture could not express, and the one a mutant would exploit: keeping
  // unprocessed retries only when a fresh failure exists.
  const ids = Array.from({ length: 10 }, (_, i) => `d${i}`);
  const split = splitProcessed({ discoveredCount: 10, retryIds: ["r1", "r2"], processed: 10 });
  const out = planRunOutcome({
    ...PLAN, discoveredIds: ids, lastDiscovered: "d9",
    processedDiscovered: split.processedDiscovered,
    unprocessedRetryIds: split.unprocessedRetryIds, freshFailureIds: [], anyFailure: false,
  });
  assertEquals(out.retryIds, ["r1", "r2"]);
  assertEquals(out.deferred, 2);
  assertEquals(out.incomplete, true);
});

Deno.test("MUTANT: dropping un-reached retries spends an attempt that never happened", () => {
  const mutant = (fresh: string[]) => fresh;
  assertEquals(mutant([]), [], "the mutant carries nothing when nothing fresh failed...");
  const split = splitProcessed({ discoveredCount: 10, retryIds: ["r1"], processed: 10 });
  assertEquals(
    planRunOutcome({
      ...PLAN, discoveredIds: Array.from({ length: 10 }, (_, i) => `d${i}`), lastDiscovered: "d9",
      processedDiscovered: split.processedDiscovered,
      unprocessedRetryIds: split.unprocessedRetryIds, freshFailureIds: [], anyFailure: false,
    }).retryIds,
    ["r1"],
  );
});

// ===========================================================================
// splitProcessed — the arithmetic the handler used to do inline.
// ===========================================================================

Deno.test("split: the recipient list is discovered-then-retries, and one number says how far it got", () => {
  // 12 discovered + 3 retries. A hop that got through the first chunk of 10 has touched no retry.
  assertEquals(splitProcessed({ discoveredCount: 12, retryIds: ["r1", "r2", "r3"], processed: 10 }),
    { processedDiscovered: 10, unprocessedRetryIds: ["r1", "r2", "r3"] });
  // ...through 20 of 15: everything, retries included.
  assertEquals(splitProcessed({ discoveredCount: 12, retryIds: ["r1", "r2", "r3"], processed: 20 }),
    { processedDiscovered: 12, unprocessedRetryIds: [] });
  // ...straddling the boundary: all discovery plus the first two retries.
  assertEquals(splitProcessed({ discoveredCount: 12, retryIds: ["r1", "r2", "r3"], processed: 14 }),
    { processedDiscovered: 12, unprocessedRetryIds: ["r3"] });
});

Deno.test("split: no discovery at all means every retry is still owed after the first chunk", () => {
  assertEquals(splitProcessed({ discoveredCount: 0, retryIds: ["r1", "r2"], processed: 1 }),
    { processedDiscovered: 0, unprocessedRetryIds: ["r2"] });
  assertEquals(splitProcessed({ discoveredCount: 0, retryIds: ["r1", "r2"], processed: 0 }),
    { processedDiscovered: 0, unprocessedRetryIds: ["r1", "r2"] });
});

Deno.test("MUTANT: slicing the retries by `processed` alone drops every un-reached retry", () => {
  // The exact regression: with 10 discovered and 2 retries, a hop that stops after the first
  // chunk has reached NO retry — but `retryIds.slice(processed)` reads that as "both done".
  const mutant = ["r1", "r2"].slice(10);
  assertEquals(mutant, [], "the mutant loses both...");
  assertEquals(
    splitProcessed({ discoveredCount: 10, retryIds: ["r1", "r2"], processed: 10 }).unprocessedRetryIds,
    ["r1", "r2"],
  );
});

Deno.test("MUTANT: counting processedDiscovered without the clamp overstates the cursor", () => {
  // 12 discovered, 3 retries, everything processed: an unclamped count would say 15 discovered
  // and walk the cursor past recipients that do not exist.
  const mutant = 15;
  assertEquals(mutant > 12, true, "the mutant claims more discovery than there was...");
  assertEquals(splitProcessed({ discoveredCount: 12, retryIds: ["r1", "r2", "r3"], processed: 15 })
    .processedDiscovered, 12);
});

// ===========================================================================
// decideBatch — SERVER-SIDE BATCH AUTHORITY.
//
// This is the whole of C-2 that can be tested without a database: given a parsed request and the
// validation RPC's single row, may this batch be announced, and on what terms? The handler adds
// only the round trip. Every refusal below is a ZERO-EFFECT refusal in production, because the
// call sits before follower discovery and before any enqueue.
// ===========================================================================

Deno.test("decideBatch: a wholly-owned public batch is accepted, and the DATABASE supplies the terms", () => {
  const d = decideBatch(baseReq(), [okRow()]);
  assertEquals(d.ok, true);
  if (!d.ok) return;
  assertEquals(d.slotCount, 3, "from public_owned_count");
  assertEquals(d.dateFrom, "2026-08-10", "from min_start_date");
  assertEquals(d.dateTo, "2026-08-16", "from max_start_date");
  assertEquals(d.occurredAt, "2026-08-07T09:15:00+00:00", "from max_created_at");
  assertEquals(d.legacyRange, "Aug 10 - Aug 16, 2026", "re-derived from the AUTHORITATIVE dates");
});

Deno.test("decideBatch: a MISSING slot refuses the whole batch — never the surviving subset", () => {
  // A slot deleted between creation and this call. Announcing the other two while reporting
  // success is the failure this replaces: the operator asked to announce a batch.
  const d = decideBatch(baseReq(), [okRow({ matched_count: 2, public_owned_count: 2 })]);
  assertEquals(d.ok, false);
  if (d.ok) return;
  assertEquals(d.error.includes("no longer exist"), true);
});

Deno.test("decideBatch: a FOREIGN or PRIVATE slot refuses the whole batch", () => {
  // matched == 3 (all three rows exist) but only 2 are this trainer's own public slots. The id
  // belongs to someone else, or it is the caller's own private slot. Both must refuse loudly.
  const d = decideBatch(baseReq(), [okRow({ public_owned_count: 2 })]);
  assertEquals(d.ok, false);
  if (d.ok) return;
  assertEquals(d.error.includes("not public slots of this trainer"), true);
});

Deno.test("decideBatch: NOTHING owned at all — the empty subset is refused, not sent about", () => {
  const d = decideBatch(baseReq(), [okRow({
    matched_count: 3, public_owned_count: 0, max_created_at: null,
    min_start_date: null, max_start_date: null,
  })]);
  assertEquals(d.ok, false);
});

Deno.test("decideBatch: a distinct-count disagreement is reported as its own thing", () => {
  const d = decideBatch(baseReq(), [okRow({ supplied_distinct_count: 2 })]);
  assertEquals(d.ok, false);
  if (d.ok) return;
  assertEquals(d.error.includes("disagreed about the submitted set"), true);
});

Deno.test("decideBatch: a COUNT disagreement refuses — the recipient never reads an unbacked number", () => {
  // The parser already pins slot_count to slot_ids.length, so this is the SECOND, independent
  // guard: the count is re-derived from public_owned_count and compared. It is what still catches
  // the defect if the parser's equality is ever relaxed.
  const req = { ...baseReq(), slotCount: 7 };
  const d = decideBatch(req, [okRow()]);
  assertEquals(d.ok, false);
  if (d.ok) return;
  assertEquals(d.error.includes("slot_count"), true);
});

Deno.test("decideBatch: a DATE disagreement refuses — the range is the idempotency subject", () => {
  // The client derived its range in the browser; the database derived it from the rows in the
  // trainer's own timezone. If those disagree, the two would build DIFFERENT subjects for one
  // batch, and the resolver would de-duplicate neither — the same followers, notified twice.
  for (
    const row of [
      okRow({ min_start_date: "2026-08-09" }),
      okRow({ max_start_date: "2026-08-17" }),
      okRow({ min_start_date: "2026-08-09", max_start_date: "2026-08-17" }),
    ]
  ) {
    const d = decideBatch(baseReq(), [row]);
    assertEquals(d.ok, false, JSON.stringify(row));
    if (d.ok) continue;
    assertEquals(d.error.includes("disagrees with the validated slots"), true);
  }
});

Deno.test("decideBatch: an UNDATEABLE batch refuses rather than falling back to now()", () => {
  for (const bad of [null, undefined, "", 12345, {}]) {
    const d = decideBatch(baseReq(), [okRow({ max_created_at: bad })]);
    assertEquals(d.ok, false, `max_created_at ${JSON.stringify(bad)} must refuse`);
    if (d.ok) continue;
    assertEquals(d.error.includes("occurrence"), true);
  }
});

Deno.test("decideBatch: an unusable or inverted date range refuses", () => {
  for (const bad of [null, "", "not-a-date", "2026-02-30", "10-08-2026", 5]) {
    assertEquals(decideBatch(baseReq(), [okRow({ min_start_date: bad })]).ok, false, JSON.stringify(bad));
    assertEquals(decideBatch(baseReq(), [okRow({ max_start_date: bad })]).ok, false, JSON.stringify(bad));
  }
  const inverted = decideBatch(baseReq(), [okRow({ min_start_date: "2026-08-16", max_start_date: "2026-08-10" })]);
  assertEquals(inverted.ok, false);
});

Deno.test("decideBatch: anything that is not EXACTLY one well-formed row refuses", () => {
  // A TABLE-returning function with an ungrouped aggregate yields exactly one row, always. Zero
  // or several means we are not talking to the function we think we are — a signature change, a
  // stale schema cache, a rewrite that started returning slots — and that is a refusal, not
  // something to take the first element of.
  for (const bad of [null, undefined, [], [okRow(), okRow()], "x", 5, [null], [42]]) {
    const d = decideBatch(baseReq(), bad);
    assertEquals(d.ok, false, `must refuse RPC data: ${JSON.stringify(bad)}`);
  }
  // A single row NOT wrapped in an array is still read (PostgREST shapes vary by client version).
  assertEquals(decideBatch(baseReq(), okRow()).ok, true);
});

Deno.test("decideBatch: malformed counts refuse rather than coercing", () => {
  for (const bad of [null, "3", 3.5, -1, undefined, {}]) {
    assertEquals(decideBatch(baseReq(), [okRow({ supplied_distinct_count: bad })]).ok, false, JSON.stringify(bad));
    assertEquals(decideBatch(baseReq(), [okRow({ matched_count: bad })]).ok, false, JSON.stringify(bad));
    assertEquals(decideBatch(baseReq(), [okRow({ public_owned_count: bad })]).ok, false, JSON.stringify(bad));
  }
});

Deno.test("decideBatch: a ONE-slot batch works — the smallest real announcement", () => {
  const req = baseReq({ slot_count: 1, slot_ids: [IDS[0]], date_from: "2026-08-10", date_to: "2026-08-10" });
  const d = decideBatch(req, [okRow({
    supplied_distinct_count: 1, matched_count: 1, public_owned_count: 1,
    min_start_date: "2026-08-10", max_start_date: "2026-08-10",
  })]);
  assertEquals(d.ok, true);
  if (!d.ok) return;
  assertEquals(d.dateFrom, d.dateTo);
  assertEquals(d.legacyRange, "Aug 10 - Aug 10, 2026", "a single-day range still prints both ends");
});

// ---------------------------------------------------------------------------
// CONTINUATION-TIME MUTATION. Every hop re-runs this, so the second hop of a run whose slots were
// deleted or turned private in between sees exactly these rows and refuses.

Deno.test("decideBatch: a batch DELETED between hops refuses on the later hop", () => {
  const req = baseReq();
  assertEquals(decideBatch(req, [okRow()]).ok, true, "hop 1: the batch is whole");
  // hop 2, after the trainer deleted one of the three slots
  const hop2 = decideBatch(req, [okRow({ matched_count: 2, public_owned_count: 2 })]);
  assertEquals(hop2.ok, false, "hop 2: the batch is no longer what was announced");
});

Deno.test("decideBatch: a batch turned PRIVATE between hops refuses on the later hop", () => {
  const req = baseReq();
  assertEquals(decideBatch(req, [okRow()]).ok, true);
  const hop2 = decideBatch(req, [okRow({ public_owned_count: 1 })]);
  assertEquals(hop2.ok, false);
  if (hop2.ok) return;
  assertEquals(hop2.error.includes("not public slots of this trainer"), true);
});

Deno.test("decideBatch: a batch whose DATES moved between hops refuses on the later hop", () => {
  // Editing a slot's start_time shifts the derived range; the announcement in flight is then
  // about a range the rows no longer occupy, and its subject would no longer match.
  const req = baseReq();
  assertEquals(decideBatch(req, [okRow()]).ok, true);
  assertEquals(decideBatch(req, [okRow({ max_start_date: "2026-08-20" })]).ok, false);
});

// ---------------------------------------------------------------------------
// MUTATION PINS for the batch authority. Each is a guard deleted; each must change the verdict.

Deno.test("MUTANT: trimming to the authorized subset announces a batch nobody asked for", () => {
  const row = okRow({ matched_count: 3, public_owned_count: 2 });
  // The mutant: proceed with whatever came back.
  const mutant = { ok: true as const, slotCount: row.public_owned_count };
  assertEquals(mutant.ok, true, "the mutant announces 2 of the 3 slots and reports success...");
  assertEquals(decideBatch(baseReq(), [row]).ok, false, "...production refuses the whole batch");
});

Deno.test("MUTANT: `>=` instead of `===` on the counts admits a padded batch", () => {
  const row = okRow({ supplied_distinct_count: 3, matched_count: 4, public_owned_count: 4 });
  const mutant = row.matched_count >= 3 && row.public_owned_count >= 3;
  assertEquals(mutant, true, "the mutant is satisfied by MORE rows than were submitted...");
  assertEquals(decideBatch(baseReq(), [row]).ok, false, "...production requires exact equality");
});

Deno.test("MUTANT: trusting the client's slot_count mails a number no row supports", () => {
  const req = { ...baseReq(), slotCount: 200 };
  const mutant = req.slotCount;                       // straight from the body
  assertEquals(mutant, 200, "the mutant announces 200 slots...");
  assertEquals(decideBatch(req, [okRow()]).ok, false, "...production refuses the disagreement");
});

Deno.test("MUTANT: trusting the client's dates keeps the day-boundary off-by-one alive", () => {
  const req = baseReq();
  const row = okRow({ min_start_date: "2026-08-09" });   // the database says the batch starts a day earlier
  const mutant = { dateFrom: req.dateFrom };             // the mutant just believes the body
  assertEquals(mutant.dateFrom, "2026-08-10", "the mutant announces the client's range...");
  assertEquals(decideBatch(req, [row]).ok, false, "...production refuses rather than picking one");
});

Deno.test("MUTANT: falling back to now() for the occurrence launders a replayed creation", () => {
  const row = okRow({ max_created_at: null });
  const mutant = row.max_created_at ?? new Date().toISOString();
  assertEquals(typeof mutant, "string", "the mutant always has an occurrence...");
  assertEquals(decideBatch(baseReq(), [row]).ok, false, "...production refuses to date what it cannot date");
});

Deno.test("MUTANT: taking data[0] blindly accepts a multi-row answer from the wrong function", () => {
  const rows = [okRow(), okRow({ public_owned_count: 99 })];
  const mutant = rows[0];
  assertEquals(mutant.public_owned_count, 3, "the mutant reads the first row and proceeds...");
  assertEquals(decideBatch(baseReq(), rows).ok, false, "...production refuses a shape it did not expect");
});

// ---------------------------------------------------------------------------
// The legacy dedup marker survives the change of authority.

Deno.test("legacy dedup key: derived, present, and unchanged in SHAPE", () => {
  const req = baseReq();
  const T = "44444444-4444-4444-4444-444444444444";
  const P = "55555555-5555-5555-5555-555555555555";
  // An ISO-only body used to produce NO key at all, silently losing the cross-version protection
  // in exactly the new-bundle-to-old-handler direction it exists for.
  assertEquals(legacyDedupKey(req, T, P), `${T}:${P}:na:Aug 10 - Aug 16, 2026`);

  // And it is byte-identical to the key built from the DERIVED range after validation.
  const d = decideBatch(req, [okRow()]);
  if (!d.ok) throw new Error("fixture");
  const validated: NotifyRequest = { ...req, legacyRange: d.legacyRange };
  assertEquals(legacyDedupKey(validated, T, P), legacyDedupKey(req, T, P));
});

Deno.test("MUTANT: an ISO-only body that yields no legacy key drops the rollback protection", () => {
  const req = baseReq();
  const T = "44444444-4444-4444-4444-444444444444";
  const P = "55555555-5555-5555-5555-555555555555";
  // The mutant: only key when the CALLER supplied a display range (the pre-correction behaviour).
  const mutantRange: string | undefined = undefined;
  assertEquals(mutantRange, undefined, "the mutant has nothing to key on...");
  assertEquals(legacyDedupKey(req, T, P) !== null, true, "...production always can");
});
