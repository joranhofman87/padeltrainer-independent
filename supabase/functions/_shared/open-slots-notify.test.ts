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
  isHhMm,
  isIsoDate,
  isUuid,
  newCounts,
  parseNotifyRequest,
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

Deno.test("parse: REFUSES the pre-cutover display date_range", () => {
  // The exact body the caller used to send. It must not be silently accepted.
  const r = parseNotifyRequest({ slot_count: 3, date_range: "Aug 10 - Aug 16, 2026" });
  assertEquals(r.ok, false);
  if (r.ok) return;
  assertEquals(r.error.includes("date_from"), true);
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

Deno.test("parse: the legacy display date_range is refused with a POINTED error", () => {
  const r = parseNotifyRequest({ slot_count: 3, date_range: "Aug 10 - Aug 16, 2026" });
  assertEquals(r.ok, false);
  if (r.ok) return;
  // A stale caller (frontend deploys automatically, edge functions manually) must get a message
  // that names the fix, not a generic "date_from must be an ISO date".
  assertEquals(r.error.includes("no longer accepted"), true);
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
