// D7 — the machine wire contract's decoders. Every one of them exists to fail CLOSED on a drifted
// database surface, so the tests here are mostly about what a decoder REFUSES.
import { assert, assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import {
  CLAIM_ORIGIN_STATES,
  decodeBeginRow,
  decodeCapabilityStatusRow,
  decodeClaimRow,
  decodeCloseRow,
  decodeMaterializeRow,
  decodeRecordRow,
  decodeRecoverRow,
  decodeResolveRow,
  decodeRows,
  decodeSingleRow,
  DISPOSITIONS,
  IDEMPOTENCY_KEY_MAX,
  isOpaqueBytea,
  TERMINAL_OUTCOMES,
  TRANSPORT_STATES,
} from "./rebook-member-open-transport.ts";

const OUT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const REC = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";

// ── The vocabularies mirror the database's, exactly ───────────────────────────────────────────

Deno.test("the closed vocabularies are exactly the sizes the migration declares", () => {
  assertEquals(TRANSPORT_STATES.length, 9);
  assertEquals(TERMINAL_OUTCOMES.length, 11);
  assertEquals(DISPOSITIONS.length, 6);
  assertEquals(CLAIM_ORIGIN_STATES.length, 4);
  // `leased` and `acceptance_uncertain` are DELIBERATELY not claim origins.
  assert(!(CLAIM_ORIGIN_STATES as readonly string[]).includes("leased"));
  assert(!(CLAIM_ORIGIN_STATES as readonly string[]).includes("acceptance_uncertain"));
  // Every origin is also a real transport state.
  for (const s of CLAIM_ORIGIN_STATES) {
    assert((TRANSPORT_STATES as readonly string[]).includes(s));
  }
});

// ── Opaque bytea ──────────────────────────────────────────────────────────────────────────────

Deno.test("both carrier shapes are accepted; nothing else is", () => {
  assert(isOpaqueBytea("\\xdeadbeef"));
  assert(isOpaqueBytea(new Uint8Array([1, 2, 3])));
  for (const bad of ["", new Uint8Array(), null, undefined, 0, {}, [], true]) {
    assert(!isOpaqueBytea(bad), `${JSON.stringify(bad)} must not read as bytea`);
  }
});

// ── Claim ─────────────────────────────────────────────────────────────────────────────────────

const claim = (over: Record<string, unknown> = {}) => ({
  outbox_id: OUT,
  rebook_round_recipient_id: REC,
  lease_generation: 2,
  leased_from_state: "queued",
  canonical_request_bytes: "{}",
  provider_idempotency_key: "k",
  request_hash: "\\xaa",
  ...over,
});

Deno.test("a well-formed claim row decodes", () => {
  const r = decodeClaimRow(claim());
  assertEquals(r?.outboxId, OUT);
  assertEquals(r?.leaseGeneration, 2);
  assertEquals(r?.leasedFromState, "queued");
});

Deno.test("an EXTRA column is drift, not something to ignore", () => {
  assertEquals(decodeClaimRow(claim({ surprise_new_column: 1 })), null);
});

Deno.test("a MISSING column is drift", () => {
  const row = claim();
  delete (row as Record<string, unknown>).request_hash;
  assertEquals(decodeClaimRow(row), null);
});

Deno.test("a lease origin outside the closed four is refused", () => {
  assertEquals(decodeClaimRow(claim({ leased_from_state: "leased" })), null);
  assertEquals(decodeClaimRow(claim({ leased_from_state: "acceptance_uncertain" })), null);
  assertEquals(decodeClaimRow(claim({ leased_from_state: "brand_new" })), null);
});

Deno.test("nothing is coerced: a string generation, a non-uuid id and a null hash all refuse", () => {
  assertEquals(decodeClaimRow(claim({ lease_generation: "2" })), null);
  assertEquals(decodeClaimRow(claim({ lease_generation: 2.5 })), null);
  assertEquals(decodeClaimRow(claim({ outbox_id: "not-a-uuid" })), null);
  assertEquals(decodeClaimRow(claim({ request_hash: null })), null);
  assertEquals(decodeClaimRow(claim({ canonical_request_bytes: "" })), null);
});

Deno.test("an over-bound provider key is a decode failure with a name, not a late refusal", () => {
  const key = "k".repeat(IDEMPOTENCY_KEY_MAX + 1);
  assertEquals(decodeClaimRow(claim({ provider_idempotency_key: key })), null);
  assert(decodeClaimRow(claim({ provider_idempotency_key: "k".repeat(IDEMPOTENCY_KEY_MAX) })));
});

// ── Resolve ───────────────────────────────────────────────────────────────────────────────────

const resolve = (over: Record<string, unknown> = {}) => ({
  disposition: "proceed", terminal_outcome: null, defer_until: null, refusal_reason: null, ...over,
});

Deno.test("every one of the six dispositions decodes with its own shape", () => {
  assertEquals(decodeResolveRow(resolve())?.disposition, "proceed");
  assertEquals(decodeResolveRow(resolve({ disposition: "deferred", defer_until: "2026-01-01T00:00:00Z" }))?.disposition, "deferred");
  assertEquals(decodeResolveRow(resolve({ disposition: "held", refusal_reason: "x" }))?.disposition, "held");
  assertEquals(
    decodeResolveRow(resolve({ disposition: "terminal_retained", terminal_outcome: "unroutable" }))?.terminalOutcome,
    "unroutable",
  );
  assertEquals(
    decodeResolveRow(resolve({ disposition: "terminal_deleted", terminal_outcome: "identity_deleted" }))?.terminalOutcome,
    "identity_deleted",
  );
  assertEquals(decodeResolveRow(resolve({ disposition: "refused", refusal_reason: "x" }))?.disposition, "refused");
});

Deno.test("a TERMINAL disposition without a terminal outcome is refused, and vice versa", () => {
  assertEquals(decodeResolveRow(resolve({ disposition: "terminal_retained" })), null);
  assertEquals(decodeResolveRow(resolve({ disposition: "terminal_deleted" })), null);
  assertEquals(decodeResolveRow(resolve({ terminal_outcome: "unroutable" })), null);
  assertEquals(
    decodeResolveRow(resolve({ disposition: "deferred", terminal_outcome: "unroutable" })),
    null,
  );
});

Deno.test("a terminal outcome outside the closed eleven is refused", () => {
  assertEquals(
    decodeResolveRow(resolve({ disposition: "terminal_retained", terminal_outcome: "delivered" })),
    null,
  );
});

Deno.test("a seventh disposition would be refused, not treated as `proceed`", () => {
  assertEquals(decodeResolveRow(resolve({ disposition: "maybe" })), null);
});

Deno.test("a Date defer_until (the `pg` carrier) is accepted alongside an ISO string", () => {
  const d = new Date("2026-01-01T00:00:00Z");
  assertEquals(decodeResolveRow(resolve({ disposition: "deferred", defer_until: d }))?.deferUntil, d);
  assertEquals(decodeResolveRow(resolve({ disposition: "deferred", defer_until: 1735689600000 })), null);
});

// ── Begin ─────────────────────────────────────────────────────────────────────────────────────

const begin = (over: Record<string, unknown> = {}) => ({
  outcome: "begun",
  first_dispatch_at: "2026-01-01T00:00:00Z",
  uncertainty_deadline_at: "2026-01-01T00:30:00Z",
  canonical_request_bytes: "{}",
  provider_idempotency_key: "k",
  refusal_reason: null,
  ...over,
});

Deno.test("a `begun` row missing either half of the frozen request is refused", () => {
  assert(decodeBeginRow(begin()));
  assertEquals(decodeBeginRow(begin({ canonical_request_bytes: null })), null);
  assertEquals(decodeBeginRow(begin({ provider_idempotency_key: null })), null);
});

Deno.test("a `refused` row must name its reason", () => {
  assertEquals(
    decodeBeginRow(begin({
      outcome: "refused", canonical_request_bytes: null, provider_idempotency_key: null,
      first_dispatch_at: null, uncertainty_deadline_at: null,
    })),
    null,
  );
  assert(decodeBeginRow(begin({
    outcome: "refused", canonical_request_bytes: null, provider_idempotency_key: null,
    first_dispatch_at: null, uncertainty_deadline_at: null, refusal_reason: "after_cutoff",
  })));
});

Deno.test("an outcome outside {begun, refused} is refused", () => {
  assertEquals(decodeBeginRow(begin({ outcome: "sent" })), null);
});

// ── Record ────────────────────────────────────────────────────────────────────────────────────

const record = (over: Record<string, unknown> = {}) => ({
  outcome: "recorded",
  transport_state: "awaiting_reconciliation",
  decision_outcome: null,
  refusal_reason: null,
  ...over,
});

Deno.test("a recording that resolved nothing at all is refused", () => {
  assertEquals(decodeRecordRow(record({ transport_state: null, decision_outcome: null })), null);
  assert(decodeRecordRow(record({ transport_state: null, decision_outcome: "dispatch_accepted" })));
});

Deno.test("an out-of-vocabulary transport state or decision is refused", () => {
  assertEquals(decodeRecordRow(record({ transport_state: "sent" })), null);
  assertEquals(decodeRecordRow(record({ decision_outcome: "delivered" })), null);
});

Deno.test("a refusal must name its reason", () => {
  assertEquals(
    decodeRecordRow(record({ outcome: "refused", transport_state: null, decision_outcome: null })),
    null,
  );
  assert(decodeRecordRow(record({
    outcome: "refused", transport_state: null, decision_outcome: null,
    refusal_reason: "capability_mismatch",
  })));
});

// ── Recover / close / materialize / capability status ─────────────────────────────────────────

Deno.test("recover and close rows decode, and refuse out-of-vocabulary values", () => {
  assert(decodeRecoverRow({ outbox_id: OUT, recovered_to: "queued", lease_generation: 1 }));
  assertEquals(decodeRecoverRow({ outbox_id: OUT, recovered_to: "gone", lease_generation: 1 }), null);
  assert(decodeCloseRow({
    outbox_id: OUT, rebook_round_recipient_id: REC, decision_outcome: "dispatch_unknown",
  }));
  assertEquals(
    decodeCloseRow({ outbox_id: OUT, rebook_round_recipient_id: REC, decision_outcome: "closed" }),
    null,
  );
});

Deno.test("a materialize row decodes with a nullable lifecycle and a strict boolean has_more", () => {
  const base = {
    round_id: OUT, academy_profile_id: REC, outcome: "materialized",
    recipients_considered: 1, decisions_written: 1, has_more: false, lifecycle: null,
  };
  assertEquals(decodeMaterializeRow(base)?.lifecycle, null);
  assertEquals(decodeMaterializeRow({ ...base, has_more: "false" }), null);
  assertEquals(decodeMaterializeRow({ ...base, recipients_considered: null }), null);
});

Deno.test("a capability-status row decodes, and refuses a drifted state or an over-bound id", () => {
  const base = {
    outcome: "observed",
    transport_state: "acceptance_uncertain",
    lease_generation: 3,
    dispatch_authorized_generation: 3,
    first_dispatch_at: "2026-01-01T00:00:00Z",
    uncertainty_deadline_at: "2026-01-01T00:30:00Z",
    provider_message_id: "msg_1",
    legacy_status: "pending",
    decision_outcome: null,
    refusal_reason: null,
  };
  assertEquals(decodeCapabilityStatusRow(base)?.transportState, "acceptance_uncertain");
  assertEquals(decodeCapabilityStatusRow({ ...base, transport_state: "sent" }), null);
  assertEquals(
    decodeCapabilityStatusRow({ ...base, provider_message_id: "m".repeat(129) }),
    null,
  );
  // A refusal is a ROW, with everything else null — that is what makes it indistinguishable from
  // "no such row".
  assert(decodeCapabilityStatusRow({
    ...base, outcome: "refused", transport_state: null, lease_generation: null,
    dispatch_authorized_generation: null, first_dispatch_at: null, uncertainty_deadline_at: null,
    provider_message_id: null, legacy_status: null, refusal_reason: "capability_mismatch",
  }));
});

// ── The list / single-row wrappers ────────────────────────────────────────────────────────────

Deno.test("one unreadable row poisons the whole batch", () => {
  assertEquals(decodeRows([claim(), { bad: 1 }], decodeClaimRow), null);
  assertEquals(decodeRows([claim(), claim()], decodeClaimRow)?.length, 2);
  assertEquals(decodeRows([], decodeClaimRow)?.length, 0);
  assertEquals(decodeRows("not-an-array", decodeClaimRow), null);
});

Deno.test("a single-row surface must return EXACTLY one row — zero and two are both drift", () => {
  assert(decodeSingleRow([resolve()], decodeResolveRow));
  assertEquals(decodeSingleRow([], decodeResolveRow), null);
  assertEquals(decodeSingleRow([resolve(), resolve()], decodeResolveRow), null);
  assertEquals(decodeSingleRow(null, decodeResolveRow), null);
});

Deno.test("an array and a bare object are both refused where an object row is expected", () => {
  assertEquals(decodeClaimRow([]), null);
  assertEquals(decodeClaimRow(null), null);
  assertEquals(decodeClaimRow("row"), null);
});
