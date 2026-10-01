import { assert, assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import {
  MAX_PRIORITY_SUBMISSIONS,
  PRIORITY_PROTOCOL_VERSION,
  PRIORITY_REFUSAL_REASONS,
  isPriorityRefusal,
  isSupportedPriorityProtocol,
  parsePriorityRefusal,
  parsePriorityRequest,
  type PriorityRefusal,
  type PriorityRefusalReason,
} from "./priority-unavailable.ts";

// ════════════════════════════════════════════════════════════════════════════════════════════
// ABC-26 — the contract authority.
//
// Everything the Edge function decides about supplementary priority is decided here, ONCE, before
// any write. So these are the discriminating tests: each one names a way a submission could be
// silently normalised (de-duplicated, truncated, coerced, admitted) and pins the honest answer.
// ════════════════════════════════════════════════════════════════════════════════════════════

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const V = PRIORITY_PROTOCOL_VERSION;

const refusalOf = (input: Parameters<typeof parsePriorityRequest>[0]): PriorityRefusal => {
  const parsed = parsePriorityRequest(input);
  assert(parsed.kind === "refused", `expected a refusal, got ${parsed.kind}`);
  return parsed.refusal;
};

// ── The one case that proceeds ──────────────────────────────────────────────────────────────

Deno.test("EMPTY: absent arms proceed — ordinary round creation is unaffected", () => {
  assertEquals(parsePriorityRequest({}).kind, "empty");
  assertEquals(parsePriorityRequest({ priorityContractVersion: V }).kind, "empty");
});

Deno.test("EMPTY: explicitly-empty arrays proceed, with or without a version", () => {
  assertEquals(
    parsePriorityRequest({ priorityPeople: [], priorityGuests: [], secondBucketSeriesKeys: [] }).kind,
    "empty",
  );
  assertEquals(
    parsePriorityRequest({ priorityPeople: [], priorityGuests: [], secondBucketSeriesKeys: [], priorityContractVersion: V }).kind,
    "empty",
  );
});

Deno.test("EMPTY: null arms are absent, not malformed", () => {
  assertEquals(parsePriorityRequest({ priorityPeople: null, priorityGuests: null }).kind, "empty");
});

// ── Every class is refused ──────────────────────────────────────────────────────────────────

Deno.test("REGISTERED alone is refused, with the RAW submitted count", () => {
  const r = refusalOf({ priorityPeople: [UUID_A, UUID_B], priorityContractVersion: V });
  assertEquals(r.reason, "priority_unavailable");
  assertEquals(r.registered, { submitted: 2, admitted: 0, refused: 2 });
  assertEquals(r.guest, { submitted: 0, admitted: 0, refused: 0 });
  assertEquals(r.secondBucket, { submitted: 0, admitted: 0, refused: 0 });
});

Deno.test("GUEST alone is refused — ownership is an editing right, not a queue position", () => {
  const r = refusalOf({ priorityGuests: [UUID_A], priorityContractVersion: V });
  assertEquals(r.reason, "priority_unavailable");
  assertEquals(r.guest, { submitted: 1, admitted: 0, refused: 1 });
});

Deno.test("SECOND BUCKET alone is refused — the same withdrawn evidence, one step removed", () => {
  const r = refusalOf({ secondBucketSeriesKeys: ["loc|trn|1|18:00"], priorityContractVersion: V });
  assertEquals(r.reason, "priority_unavailable");
  assertEquals(r.secondBucket, { submitted: 1, admitted: 0, refused: 1 });
});

Deno.test("ALL THREE together: every arm is counted, none is folded into another", () => {
  const r = refusalOf({
    priorityPeople: [UUID_A],
    priorityGuests: [UUID_A, UUID_B],
    secondBucketSeriesKeys: ["k1", "k2", "k3"],
    priorityContractVersion: V,
  });
  assertEquals(r.reason, "priority_unavailable");
  assertEquals(r.registered.submitted, 1);
  assertEquals(r.guest.submitted, 2);
  assertEquals(r.secondBucket.submitted, 3);
});

Deno.test("a refusal is never a partial success: admitted is 0 and refused equals submitted", () => {
  const r = refusalOf({ priorityPeople: [UUID_A, UUID_B], priorityGuests: [UUID_A], priorityContractVersion: V });
  for (const arm of [r.registered, r.guest, r.secondBucket]) {
    assertEquals(arm.admitted, 0);
    assertEquals(arm.refused, arm.submitted);
  }
});

// ── Structural faults, reported as themselves ───────────────────────────────────────────────

Deno.test("BLANK and whitespace-only identifiers are blank_identifier, not invalid", () => {
  assertEquals(refusalOf({ priorityPeople: [""], priorityContractVersion: V }).reason, "blank_identifier");
  assertEquals(refusalOf({ priorityPeople: ["   "], priorityContractVersion: V }).reason, "blank_identifier");
});

Deno.test("a non-UUID identifier is invalid_identifier", () => {
  assertEquals(refusalOf({ priorityPeople: ["not-a-uuid"], priorityContractVersion: V }).reason, "invalid_identifier");
});

Deno.test("a non-array arm is malformed_input even though it would count as zero", () => {
  assertEquals(refusalOf({ priorityPeople: "abc" }).reason, "malformed_input");
  assertEquals(refusalOf({ priorityGuests: 7 }).reason, "malformed_input");
  assertEquals(refusalOf({ secondBucketSeriesKeys: {} }).reason, "malformed_input");
});

Deno.test("a non-string ENTRY is malformed_input", () => {
  assertEquals(refusalOf({ priorityPeople: [123], priorityContractVersion: V }).reason, "malformed_input");
  assertEquals(refusalOf({ secondBucketSeriesKeys: [null], priorityContractVersion: V }).reason, "malformed_input");
});

Deno.test("DUPLICATES are reported, never de-duplicated away", () => {
  const r = refusalOf({ priorityPeople: [UUID_A, UUID_A], priorityContractVersion: V });
  assertEquals(r.reason, "duplicate_identifier");
  assertEquals(r.registered.submitted, 2, "the raw count must still be 2");
});

Deno.test("DUPLICATES are case-insensitive — a UUID is one identifier regardless of case", () => {
  const r = refusalOf({ priorityPeople: [UUID_A, UUID_A.toUpperCase()], priorityContractVersion: V });
  assertEquals(r.reason, "duplicate_identifier");
});

Deno.test("DUPLICATES survive surrounding whitespace", () => {
  assertEquals(
    refusalOf({ priorityGuests: [UUID_A, ` ${UUID_A} `], priorityContractVersion: V }).reason,
    "duplicate_identifier",
  );
});

Deno.test("SECOND-BUCKET duplicates are caught too — the arm an earlier draft skipped entirely", () => {
  const r = refusalOf({ secondBucketSeriesKeys: ["loc|trn|1|18:00", "LOC|TRN|1|18:00"], priorityContractVersion: V });
  assertEquals(r.reason, "duplicate_identifier");
  assertEquals(r.secondBucket.submitted, 2);
});

Deno.test("second-bucket entries are NOT required to be UUIDs — they are composite series keys", () => {
  // A refusal, but for the ordinary reason: the shape is fine, the feature is unavailable.
  assertEquals(
    refusalOf({ secondBucketSeriesKeys: ["loc|trn|1|18:00"], priorityContractVersion: V }).reason,
    "priority_unavailable",
  );
});

Deno.test("the 201st entry is REFUSED, never sliced — and the raw count is reported", () => {
  const over = Array.from({ length: MAX_PRIORITY_SUBMISSIONS + 1 }, (_, i) =>
    `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`);
  const r = refusalOf({ priorityPeople: over, priorityContractVersion: V });
  assertEquals(r.reason, "too_many_submitted");
  assertEquals(r.registered.submitted, MAX_PRIORITY_SUBMISSIONS + 1);
  assertEquals(r.registered.refused, MAX_PRIORITY_SUBMISSIONS + 1);
});

Deno.test("exactly MAX entries is not over the cap — it is refused as unavailable", () => {
  const at = Array.from({ length: MAX_PRIORITY_SUBMISSIONS }, (_, i) =>
    `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`);
  assertEquals(refusalOf({ priorityPeople: at, priorityContractVersion: V }).reason, "priority_unavailable");
});

Deno.test("a structural fault outranks priority_unavailable — the operator needs the real reason", () => {
  assertEquals(
    refusalOf({ priorityPeople: ["not-a-uuid"], priorityContractVersion: V }).reason,
    "invalid_identifier",
  );
});

// ── Version handling: EXACT equality, in both directions ────────────────────────────────────

Deno.test("EXACT version: missing, stale, future, non-numeric and NaN all fail closed", () => {
  for (const v of [undefined, null, V - 1, V + 1, "2", true, {}, NaN]) {
    assertEquals(isSupportedPriorityProtocol(v), false, `version ${String(v)} must not be supported`);
  }
  assertEquals(isSupportedPriorityProtocol(V), true);
});

Deno.test("a FUTURE version is refused, not treated as compatible", () => {
  assertEquals(
    refusalOf({ priorityPeople: [UUID_A], priorityContractVersion: V + 1 }).reason,
    "unsupported_protocol_version",
  );
});

Deno.test("a version-less client submitting a selection gets unsupported_protocol_version", () => {
  assertEquals(refusalOf({ priorityPeople: [UUID_A] }).reason, "unsupported_protocol_version");
});

Deno.test("version is only consulted once the input is structurally sound", () => {
  // A malformed submission from a stale client is told it is malformed, not that it is stale.
  assertEquals(refusalOf({ priorityPeople: [""] }).reason, "blank_identifier");
});

// ── The runtime decoder ─────────────────────────────────────────────────────────────────────

const goodArm = { submitted: 2, admitted: 0, refused: 2 };
const goodRefusal = () => ({
  version: V, available: false, reason: "priority_unavailable" as PriorityRefusalReason,
  registered: { ...goodArm }, guest: { submitted: 0, admitted: 0, refused: 0 },
  secondBucket: { submitted: 0, admitted: 0, refused: 0 },
});

Deno.test("decoder: a well-formed refusal parses, and totalSubmitted is computed here", () => {
  const parsed = parsePriorityRefusal({
    ...goodRefusal(),
    guest: { submitted: 3, admitted: 0, refused: 3 },
    secondBucket: { submitted: 1, admitted: 0, refused: 1 },
  });
  assert(parsed.ok);
  assertEquals(parsed.totalSubmitted, 6);
  assertEquals(parsed.refusal.reason, "priority_unavailable");
});

Deno.test("decoder: everything the old type-guard let through is now rejected", () => {
  const bad: unknown[] = [
    null, undefined, 0, "refusal", [],
    { ...goodRefusal(), version: V + 1 },                     // future version
    { ...goodRefusal(), version: String(V) },                 // stringly version
    { ...goodRefusal(), available: true },                    // not a refusal at all
    { ...goodRefusal(), reason: "made_up" },                  // reason outside the enum
    { ...goodRefusal(), reason: 7 },                          // non-string reason
    { ...goodRefusal(), extra: 1 },                           // unknown key
    { version: V, available: false, reason: "priority_unavailable" },   // arms missing entirely
    { ...goodRefusal(), registered: null },                   // arm not an object
    { ...goodRefusal(), registered: [2, 0, 2] },              // arm is an array
    { ...goodRefusal(), registered: { submitted: 2, admitted: 0 } },     // arm key missing
    { ...goodRefusal(), registered: { submitted: 2, admitted: 0, refused: 2, extra: 1 } },
    { ...goodRefusal(), registered: { submitted: -1, admitted: 0, refused: -1 } },  // negative
    { ...goodRefusal(), registered: { submitted: 1.5, admitted: 0, refused: 1.5 } }, // fractional
    { ...goodRefusal(), registered: { submitted: NaN, admitted: 0, refused: NaN } },
    { ...goodRefusal(), registered: { submitted: "2", admitted: 0, refused: "2" } }, // stringly
    { ...goodRefusal(), registered: { submitted: 2, admitted: 1, refused: 1 } },     // admitted > 0
    { ...goodRefusal(), registered: { submitted: 2, admitted: 0, refused: 1 } },     // partial
  ];
  for (const v of bad) {
    assertEquals(parsePriorityRefusal(v).ok, false, `should not parse: ${JSON.stringify(v)}`);
    assertEquals(isPriorityRefusal(v), false, `guard must agree: ${JSON.stringify(v)}`);
  }
});

Deno.test("decoder: the guard and the decoder are ONE definition, not two that can drift", () => {
  const good = goodRefusal();
  assertEquals(isPriorityRefusal(good), parsePriorityRefusal(good).ok);
  assert(isPriorityRefusal(good));
});

Deno.test("decoder: every emitted refusal round-trips through the decoder", () => {
  // The strongest available statement that the emitter and the receiver agree: take a refusal for
  // each reason the emitter can actually produce, JSON round-trip it, and decode it.
  const inputs: Array<[PriorityRefusalReason, Parameters<typeof parsePriorityRequest>[0]]> = [
    ["priority_unavailable", { priorityPeople: [UUID_A], priorityContractVersion: V }],
    ["unsupported_protocol_version", { priorityPeople: [UUID_A] }],
    ["blank_identifier", { priorityPeople: [""], priorityContractVersion: V }],
    ["invalid_identifier", { priorityPeople: ["nope"], priorityContractVersion: V }],
    ["malformed_input", { priorityPeople: [1], priorityContractVersion: V }],
    ["duplicate_identifier", { priorityPeople: [UUID_A, UUID_A], priorityContractVersion: V }],
    ["too_many_submitted", {
      priorityPeople: Array.from({ length: MAX_PRIORITY_SUBMISSIONS + 1 }, (_, i) =>
        `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`),
      priorityContractVersion: V,
    }],
  ];
  const seen = new Set<string>();
  for (const [expected, input] of inputs) {
    const emitted = refusalOf(input);
    assertEquals(emitted.reason, expected);
    const decoded = parsePriorityRefusal(JSON.parse(JSON.stringify(emitted)));
    assert(decoded.ok, `emitted ${expected} must decode`);
    assertEquals(decoded.refusal.reason, expected);
    seen.add(expected);
  }
  // Every reason in the vocabulary is exercised — a new reason with no test fails here.
  assertEquals([...seen].sort(), [...PRIORITY_REFUSAL_REASONS].sort());
});
