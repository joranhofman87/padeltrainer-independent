// Deno tests for the PRODUCTION Resend-callback primitives (10c-b E).
//
// These import the real module resend-webhook/index.ts imports — not a copy — so dropping an
// event mapping, mis-reading the digest tag, or reclassifying a failure as acknowledgeable breaks
// this suite. The handler ends in `serve(...)` and can never be imported, which is exactly why
// every rule lives in the module.
import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import {
  applyOutcomeNeedsAlert,
  DIGEST_TRANSITION_EVENTS,
  extractDigestGroupId,
  isPermanentApplyError,
  parseResendEvent,
  RESEND_EVENT_MAP,
} from "./resend-webhook-events.ts";

const GROUP = "11111111-1111-4111-8111-111111111111";
const evt = (type: string, data: Record<string, unknown> = {}) =>
  ({ type, created_at: "2026-08-03T10:00:00Z", data: { to: ["p@example.com"], email_id: "re_1", ...data } });

// ---------------------------------------------------------------------------
Deno.test("the suppression axis is MAPPED — it was acknowledged and discarded before", () => {
  // The database has understood both since 20261006100000 (provider_suppressed_active, and the
  // status CHECK that lists them). The only thing missing was this map, so a Resend suppression
  // never reached is_email_suppressed and the address kept being mailed.
  assertEquals(RESEND_EVENT_MAP["email.suppressed"], "suppressed");
  assertEquals(RESEND_EVENT_MAP["suppression.removed"], "suppression_removed");
});

Deno.test("all seven ADR §PV callbacks drive a digest transition, and removal does not", () => {
  for (const t of ["sent", "delivery_delayed", "delivered", "complained", "bounced", "failed", "suppressed"]) {
    assertEquals(DIGEST_TRANSITION_EVENTS.has(t), true, t);
  }
  assertEquals(DIGEST_TRANSITION_EVENTS.size, 7);
  // suppression.removed is an ADDRESS-level recovery, not evidence about any one send — §PV has
  // no row for it, and inventing one would resurrect a group the provider never spoke about.
  assertEquals(DIGEST_TRANSITION_EVENTS.has("suppression_removed"), false);
  assertEquals(parseResendEvent(evt("suppression.removed"))?.drivesDigest, false);
});

Deno.test("parse: a delivered callback, fully normalised", () => {
  const p = parseResendEvent(evt("email.delivered", { tags: [{ name: "digest_group_id", value: GROUP }] }));
  assertEquals(p?.eventType, "delivered");
  assertEquals(p?.recipient, "p@example.com");
  assertEquals(p?.resendEmailId, "re_1");
  assertEquals(p?.occurredAt, "2026-08-03T10:00:00Z");
  assertEquals(p?.digestGroupId, GROUP);
  assertEquals(p?.drivesDigest, true);
});

Deno.test("parse: engagement and unmapped types are ignored, not half-handled", () => {
  for (const t of ["email.opened", "email.clicked", "contact.created", ""]) {
    assertEquals(parseResendEvent(evt(t)), null, t);
  }
  assertEquals(parseResendEvent(null), null);
  assertEquals(parseResendEvent("nope"), null);
  // a mapped type with no recipient cannot be recorded against an address
  assertEquals(parseResendEvent({ type: "email.delivered", data: { to: [] } }), null);
  assertEquals(parseResendEvent({ type: "email.delivered", data: {} }), null);
});

Deno.test("parse: only a clear PERMANENT bounce suppresses", () => {
  const hard = parseResendEvent(evt("email.bounced", { bounce: { type: "Permanent", message: "no such user" } }));
  assertEquals([hard?.bounceType, hard?.reason], ["hard", "no such user"]);
  const soft = parseResendEvent(evt("email.bounced", { bounce: { type: "Transient" } }));
  assertEquals([soft?.bounceType, soft?.reason], ["soft", "Transient"]);
  // no bounce block at all is still conservative
  assertEquals(parseResendEvent(evt("email.bounced"))?.bounceType, "soft");
});

Deno.test("MUTANT: treating any bounce as hard would suppress on a full mailbox", () => {
  const mutant = (_type?: string) => "hard";
  assertEquals(mutant("Transient"), "hard", "the mutant suppresses a soft bounce...");
  assertEquals(parseResendEvent(evt("email.bounced", { bounce: { type: "Transient" } }))?.bounceType, "soft");
});

// ---------------------------------------------------------------------------
Deno.test("tag: read from the array-of-pairs form the send API uses", () => {
  assertEquals(extractDigestGroupId({ tags: [{ name: "other", value: "x" }, { name: "digest_group_id", value: GROUP }] }), GROUP);
});

Deno.test("tag: read from the flat object form some payloads carry", () => {
  assertEquals(extractDigestGroupId({ tags: { digest_group_id: GROUP, other: "x" } }), GROUP);
});

Deno.test("tag: a MALFORMED value is absent, not passed on", () => {
  // apply_notification_provider_event RAISES on a tag it cannot resolve, so forwarding junk would
  // turn a foreign email into a loud, permanently failing webhook. Absent falls back to
  // correlating by provider_message_id, which is the correct behaviour for a non-digest send.
  for (const tags of [
    [{ name: "digest_group_id", value: "not-a-uuid" }],
    [{ name: "digest_group_id", value: 42 }],
    [{ name: "digest_group_id" }],
    [{ value: GROUP }],
    [null, "x", 7],
    { digest_group_id: "nope" },
    { other: GROUP },
    "tags",
    undefined,
  ]) {
    assertEquals(extractDigestGroupId({ tags }), null, JSON.stringify(tags));
  }
  assertEquals(extractDigestGroupId(null), null);
  assertEquals(extractDigestGroupId("x"), null);
});

Deno.test("MUTANT: forwarding an unvalidated tag makes a foreign email fail for ever", () => {
  const mutant = (t: Record<string, unknown>) => (t.tags as Array<Record<string, unknown>>)[0].value;
  assertEquals(mutant({ tags: [{ name: "digest_group_id", value: "not-a-uuid" }] }), "not-a-uuid");
  assertEquals(extractDigestGroupId({ tags: [{ name: "digest_group_id", value: "not-a-uuid" }] }), null);
});

// ---------------------------------------------------------------------------
Deno.test("apply errors: permanent ones are acknowledged, everything else is RETRIED", () => {
  // Permanent = an immutable disagreement no retry can change.
  assertEquals(isPermanentApplyError("apply_notification_provider_event: unknown/stale digest_group_id abc"), true);
  assertEquals(isPermanentApplyError("digest_group_id x is channel whatsapp, not email"), true);
  assertEquals(isPermanentApplyError("resend_event_id x collision (recorded a/b vs supplied c/d)"), true);
  // Transient = anything we have not reasoned about. The DEFAULT, deliberately: a needless retry
  // is far safer than silently acknowledging a callback that was never applied.
  for (const m of [
    "could not serialize access due to concurrent update",
    "canceling statement due to lock timeout",
    "deadlock detected",
    "connection terminated unexpectedly",
    "",
  ]) {
    assertEquals(isPermanentApplyError(m), false, m);
  }
  assertEquals(isPermanentApplyError(null), false);
  assertEquals(isPermanentApplyError(undefined), false);
});

Deno.test("MUTANT: defaulting to PERMANENT would ack a callback a lock timeout dropped", () => {
  const mutant = (_m: string) => true;
  assertEquals(mutant("deadlock detected"), true, "the mutant acknowledges a transient failure...");
  assertEquals(isPermanentApplyError("deadlock detected"), false);
});

Deno.test("outcomes: an orphan is NORMAL, a mismatch is not", () => {
  // An orphan is the queue doing its job — the callback beat the group's provider-message binding
  // and is enrolled for reconciliation. A mismatch means something correlated wrongly.
  assertEquals(applyOutcomeNeedsAlert("orphan"), false);
  assertEquals(applyOutcomeNeedsAlert("not_digest"), false);
  assertEquals(applyOutcomeNeedsAlert("duplicate"), false);
  assertEquals(applyOutcomeNeedsAlert(null), false);
  assertEquals(applyOutcomeNeedsAlert("mismatch"), true);
});
