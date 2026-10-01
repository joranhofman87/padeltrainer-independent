/**
 * D7 — the MACHINE-side wire contract for the `rebook_member_open_player` transport.
 *
 * This module holds exactly two things and deliberately nothing else:
 *
 *   1. the CLOSED vocabularies the database owns, mirrored so the worker can branch on them
 *      exhaustively rather than on free text;
 *   2. STRICT row decoders for every machine RPC the worker is allowed to call.
 *
 * WHAT IT DOES NOT HOLD, AND WHY.
 *
 *   • No provider classifier vocabulary. `rebook_round_provider_classifiers()` is the database's
 *     sole authority; a mirror of it here would be an invitation to classify client-side, which is
 *     the one thing D7's transport boundary exists to prevent. The worker records a raw observation
 *     and reads back whatever the server decided.
 *   • No transport-fault or bound constants of its own. They live at the observed-send boundary and
 *     are RE-EXPORTED below, never restated: two spellings of one bound is how a ceiling silently
 *     becomes two different ceilings.
 *
 * WHY THE DECODERS ARE EXACT-KEY-SET AND NOT SHAPE-TOLERANT. Both transports that carry these rows
 * — PostgREST in Deno and a `pg` client in the real-Postgres suite — return exactly the columns of
 * the function's `RETURNS TABLE`. So an unexpected key, a missing key or a wrong-typed value means
 * the database surface has drifted from this contract, and the only safe reading of a drifted
 * surface is "unreadable". Every decoder therefore returns `null` rather than a coerced object, and
 * the worker turns `null` into a run-level error. A decoder that guessed would let a renamed column
 * arrive as `undefined` and be dispatched on.
 *
 * BYTEA IS OPAQUE HERE, ON PURPOSE. `request_hash` crosses PostgREST as a `"\\x…"` hex string and
 * `pg` as a `Uint8Array`. The worker never inspects it — it hands the value straight back to
 * `begin_dispatch` and `record_dispatch_outcome`, which re-verify it server-side. Interpreting it
 * would mean choosing one transport's spelling and silently corrupting the other, so the contract
 * validates only that a value is PRESENT and of one of the two carrier shapes.
 */

import {
  IDEMPOTENCY_KEY_MAX,
  OBSERVED_SEND_TIMEOUT_MS,
  PROVIDER_ERROR_CODE_MAX,
  PROVIDER_MESSAGE_ID_MAX,
  TRANSPORT_FAULTS,
  type ObservedSendResult,
  type TransportFault,
} from "./rebook-member-open-observed-send.ts";

// Re-exported, never restated. The observed-send boundary is the single definition site for the
// provider-facing bounds and the transport-fault vocabulary; this module is where the worker
// reaches them so it never grows a second copy that can drift.
export {
  IDEMPOTENCY_KEY_MAX,
  OBSERVED_SEND_TIMEOUT_MS,
  PROVIDER_ERROR_CODE_MAX,
  PROVIDER_MESSAGE_ID_MAX,
  TRANSPORT_FAULTS,
};
export type { ObservedSendResult, TransportFault };

// ── The closed vocabularies the database owns ────────────────────────────────────────────────

/** `rebook_round_transport_states()` — the nine NONTERMINAL states. None of them is a decision. */
export const TRANSPORT_STATES = [
  "needs_admission",
  "queued",
  "leased",
  "quiet_hours_deferred",
  "channel_kill_deferred",
  "retry_wait",
  "acceptance_uncertain",
  "awaiting_reconciliation",
  "configuration_hold",
] as const;
export type TransportState = typeof TRANSPORT_STATES[number];

/** `rebook_round_terminal_outcomes()` — the eleven terminal decisions. The worker never writes one. */
export const TERMINAL_OUTCOMES = [
  "dispatch_accepted",
  "ineligible",
  "member_window_closed",
  "quiet_hours_window_conflict",
  "recipient_opted_out",
  "academy_channel_disabled",
  "unroutable",
  "identity_deleted",
  "renderer_permanent_failure",
  "provider_permanent_refusal",
  "dispatch_unknown",
] as const;
export type TerminalOutcome = typeof TERMINAL_OUTCOMES[number];

/**
 * The four states `rebook_member_open_claim_batch` admits as a lease ORIGIN.
 *
 * Mirrored so a claimed row's `leased_from_state` can be validated before it is handed back to
 * `begin_dispatch`, which re-checks it server-side. `leased` and `acceptance_uncertain` are absent
 * by the migration's own reasoning and must stay absent here.
 */
export const CLAIM_ORIGIN_STATES = [
  "queued",
  "retry_wait",
  "quiet_hours_deferred",
  "channel_kill_deferred",
] as const;
export type ClaimOriginState = typeof CLAIM_ORIGIN_STATES[number];

/** `rebook_member_open_pre_dispatch_resolve` — the six dispositions. Exactly one is sendable. */
export const DISPOSITIONS = [
  "proceed",
  "deferred",
  "held",
  "terminal_retained",
  "terminal_deleted",
  "refused",
] as const;
export type Disposition = typeof DISPOSITIONS[number];

/** `rebook_member_open_begin_dispatch` — the two outcomes. */
export const BEGIN_OUTCOMES = ["begun", "refused"] as const;
export type BeginOutcome = typeof BEGIN_OUTCOMES[number];

/** `rebook_member_open_record_dispatch_outcome` — the two outcomes. */
export const RECORD_OUTCOMES = ["recorded", "refused"] as const;
export type RecordOutcome = typeof RECORD_OUTCOMES[number];

/** `rebook_member_open_dispatch_status_by_capability` — the two outcomes. */
export const CAPABILITY_STATUS_OUTCOMES = ["observed", "refused"] as const;
export type CapabilityStatusOutcome = typeof CAPABILITY_STATUS_OUTCOMES[number];

/** `rebook_round_materialize` — a per-round page result is one of these. */
export const MATERIALIZE_OUTCOMES = [
  "materialized",
  "skipped",
  "error",
] as const;

// ── Opaque bytea ─────────────────────────────────────────────────────────────────────────────

/**
 * A `bytea` value as one of the two shapes its carriers produce, never interpreted.
 * PostgREST → a `"\\x…"` hex string. `pg` → a `Uint8Array` (node's `Buffer` is one).
 */
export type OpaqueBytea = string | Uint8Array;

/** True only for a PRESENT value in one of the two carrier shapes. Never inspects the bytes. */
export function isOpaqueBytea(value: unknown): value is OpaqueBytea {
  if (typeof value === "string") return value.length > 0;
  return value instanceof Uint8Array && value.length > 0;
}

// ── Strict decoding primitives ───────────────────────────────────────────────────────────────

/**
 * The row must be a plain object whose key set is EXACTLY `keys` — no extras, none missing.
 *
 * Extras matter as much as omissions: a surface that grew a column is a surface this contract was
 * not reviewed against, and silently ignoring it is how a security-relevant field (a refusal
 * reason, a generation) gets added server-side and never read.
 */
function hasExactKeys(row: unknown, keys: readonly string[]): row is Record<string, unknown> {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return false;
  const actual = Object.keys(row as Record<string, unknown>);
  if (actual.length !== keys.length) return false;
  for (const k of keys) if (!Object.prototype.hasOwnProperty.call(row, k)) return false;
  return true;
}

/** A member of a closed vocabulary, or `null`. Never a coercion, never a default. */
function member<T extends string>(value: unknown, vocabulary: readonly T[]): T | null {
  return typeof value === "string" && (vocabulary as readonly string[]).includes(value)
    ? value as T
    : null;
}

/** A non-empty string, or `null`. */
function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A nullable string: `null`/`undefined` pass through as `null`, a non-string is a decode failure. */
function nullableStr(value: unknown): { ok: true; value: string | null } | { ok: false } {
  if (value === null || value === undefined) return { ok: true, value: null };
  return typeof value === "string" ? { ok: true, value } : { ok: false };
}

/** An integer. PostgREST delivers `int` as a JSON number; `pg` delivers it as a number too. */
function int(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** A UUID-shaped string, or `null`. Shape only — the database owns identity. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(value: unknown): string | null {
  return typeof value === "string" && UUID_RE.test(value) ? value : null;
}

/**
 * A `timestamptz` as the carrier delivered it, or `null`.
 *
 * PostgREST hands over an ISO string; `pg` hands over a `Date`. The worker only ever passes these
 * back or logs their presence, so — like `bytea` — the contract validates the CARRIER SHAPE and
 * refuses to normalise. A normalised copy would be a second clock reading, and the database
 * samples its clock exactly once per resolution on purpose.
 */
export type OpaqueTimestamp = string | Date;
function nullableTimestamp(
  value: unknown,
): { ok: true; value: OpaqueTimestamp | null } | { ok: false } {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value === "string" && value.length > 0) return { ok: true, value };
  if (value instanceof Date) return { ok: true, value };
  return { ok: false };
}

/** A boolean, or `null`. */
function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

// ── The decoded row shapes ───────────────────────────────────────────────────────────────────

/** One row of `rebook_member_open_claim_batch` — the frozen capability for exactly one send. */
export interface ClaimedRow {
  outboxId: string;
  recipientId: string;
  leaseGeneration: number;
  leasedFromState: ClaimOriginState;
  canonicalRequestBytes: string;
  providerIdempotencyKey: string;
  requestHash: OpaqueBytea;
}

const CLAIM_KEYS = [
  "outbox_id",
  "rebook_round_recipient_id",
  "lease_generation",
  "leased_from_state",
  "canonical_request_bytes",
  "provider_idempotency_key",
  "request_hash",
] as const;

export function decodeClaimRow(row: unknown): ClaimedRow | null {
  if (!hasExactKeys(row, CLAIM_KEYS)) return null;
  const outboxId = uuid(row.outbox_id);
  const recipientId = uuid(row.rebook_round_recipient_id);
  const leaseGeneration = int(row.lease_generation);
  const leasedFromState = member(row.leased_from_state, CLAIM_ORIGIN_STATES);
  const canonicalRequestBytes = str(row.canonical_request_bytes);
  const providerIdempotencyKey = str(row.provider_idempotency_key);
  if (
    outboxId === null || recipientId === null || leaseGeneration === null ||
    leasedFromState === null || canonicalRequestBytes === null ||
    providerIdempotencyKey === null || !isOpaqueBytea(row.request_hash)
  ) return null;
  // The provider key bound is the observed-send boundary's, re-checked here so an over-long key is
  // a decode failure with a name rather than a zero-call refusal deep inside the send.
  if (providerIdempotencyKey.length > IDEMPOTENCY_KEY_MAX) return null;
  return {
    outboxId,
    recipientId,
    leaseGeneration,
    leasedFromState,
    canonicalRequestBytes,
    providerIdempotencyKey,
    requestHash: row.request_hash,
  };
}

/** The single row of `rebook_member_open_pre_dispatch_resolve`. */
export interface ResolveRow {
  disposition: Disposition;
  terminalOutcome: TerminalOutcome | null;
  deferUntil: OpaqueTimestamp | null;
  refusalReason: string | null;
}

const RESOLVE_KEYS = ["disposition", "terminal_outcome", "defer_until", "refusal_reason"] as const;

export function decodeResolveRow(row: unknown): ResolveRow | null {
  if (!hasExactKeys(row, RESOLVE_KEYS)) return null;
  const disposition = member(row.disposition, DISPOSITIONS);
  if (disposition === null) return null;
  // A terminal outcome is REQUIRED on the two terminal arms and FORBIDDEN elsewhere. The database
  // already holds that shape; asserting it here means a drifted arm cannot be silently dispatched
  // on as though it were `proceed`.
  const terminal = row.terminal_outcome === null || row.terminal_outcome === undefined
    ? null
    : member(row.terminal_outcome, TERMINAL_OUTCOMES);
  const isTerminal = disposition === "terminal_retained" || disposition === "terminal_deleted";
  if (isTerminal !== (terminal !== null)) return null;
  if (row.terminal_outcome !== null && row.terminal_outcome !== undefined && terminal === null) {
    return null;
  }
  const until = nullableTimestamp(row.defer_until);
  if (!until.ok) return null;
  const reason = nullableStr(row.refusal_reason);
  if (!reason.ok) return null;
  return {
    disposition,
    terminalOutcome: terminal,
    deferUntil: until.value,
    refusalReason: reason.value,
  };
}

/** The single row of `rebook_member_open_begin_dispatch`. */
export interface BeginRow {
  outcome: BeginOutcome;
  firstDispatchAt: OpaqueTimestamp | null;
  uncertaintyDeadlineAt: OpaqueTimestamp | null;
  canonicalRequestBytes: string | null;
  providerIdempotencyKey: string | null;
  refusalReason: string | null;
}

const BEGIN_KEYS = [
  "outcome",
  "first_dispatch_at",
  "uncertainty_deadline_at",
  "canonical_request_bytes",
  "provider_idempotency_key",
  "refusal_reason",
] as const;

export function decodeBeginRow(row: unknown): BeginRow | null {
  if (!hasExactKeys(row, BEGIN_KEYS)) return null;
  const outcome = member(row.outcome, BEGIN_OUTCOMES);
  if (outcome === null) return null;
  const first = nullableTimestamp(row.first_dispatch_at);
  const deadline = nullableTimestamp(row.uncertainty_deadline_at);
  const bytes = nullableStr(row.canonical_request_bytes);
  const key = nullableStr(row.provider_idempotency_key);
  const reason = nullableStr(row.refusal_reason);
  if (!first.ok || !deadline.ok || !bytes.ok || !key.ok || !reason.ok) return null;
  // A `begun` row MUST carry the frozen request it authorized. Without both halves there is
  // nothing to send, and treating a half-populated authorization as sendable is exactly how a
  // request that the server never froze reaches a provider.
  if (outcome === "begun" && (bytes.value === null || key.value === null)) return null;
  // A refusal MUST name its reason, or the worker cannot log which fence it hit.
  if (outcome === "refused" && reason.value === null) return null;
  return {
    outcome,
    firstDispatchAt: first.value,
    uncertaintyDeadlineAt: deadline.value,
    canonicalRequestBytes: bytes.value,
    providerIdempotencyKey: key.value,
    refusalReason: reason.value,
  };
}

/** The single row of `rebook_member_open_record_dispatch_outcome`. */
export interface RecordRow {
  outcome: RecordOutcome;
  transportState: TransportState | null;
  decisionOutcome: TerminalOutcome | null;
  refusalReason: string | null;
}

const RECORD_KEYS = ["outcome", "transport_state", "decision_outcome", "refusal_reason"] as const;

export function decodeRecordRow(row: unknown): RecordRow | null {
  if (!hasExactKeys(row, RECORD_KEYS)) return null;
  const outcome = member(row.outcome, RECORD_OUTCOMES);
  if (outcome === null) return null;
  const transport = row.transport_state === null || row.transport_state === undefined
    ? null
    : member(row.transport_state, TRANSPORT_STATES);
  if ((row.transport_state !== null && row.transport_state !== undefined) && transport === null) {
    return null;
  }
  const decision = row.decision_outcome === null || row.decision_outcome === undefined
    ? null
    : member(row.decision_outcome, TERMINAL_OUTCOMES);
  if ((row.decision_outcome !== null && row.decision_outcome !== undefined) && decision === null) {
    return null;
  }
  const reason = nullableStr(row.refusal_reason);
  if (!reason.ok) return null;
  if (outcome === "refused" && reason.value === null) return null;
  // A recording that resolved neither a transport state nor a decision resolved nothing at all.
  if (outcome === "recorded" && transport === null && decision === null) return null;
  return {
    outcome,
    transportState: transport,
    decisionOutcome: decision,
    refusalReason: reason.value,
  };
}

/** One row of `rebook_member_open_recover_expired_leases`. */
export interface RecoveredRow {
  outboxId: string;
  recoveredTo: TransportState;
  leaseGeneration: number;
}

const RECOVER_KEYS = ["outbox_id", "recovered_to", "lease_generation"] as const;

export function decodeRecoverRow(row: unknown): RecoveredRow | null {
  if (!hasExactKeys(row, RECOVER_KEYS)) return null;
  const outboxId = uuid(row.outbox_id);
  const recoveredTo = member(row.recovered_to, TRANSPORT_STATES);
  const leaseGeneration = int(row.lease_generation);
  if (outboxId === null || recoveredTo === null || leaseGeneration === null) return null;
  return { outboxId, recoveredTo, leaseGeneration };
}

/** One row of `rebook_member_open_close_unresolved`. */
export interface ClosedRow {
  outboxId: string;
  recipientId: string;
  decisionOutcome: TerminalOutcome;
}

const CLOSE_KEYS = ["outbox_id", "rebook_round_recipient_id", "decision_outcome"] as const;

export function decodeCloseRow(row: unknown): ClosedRow | null {
  if (!hasExactKeys(row, CLOSE_KEYS)) return null;
  const outboxId = uuid(row.outbox_id);
  const recipientId = uuid(row.rebook_round_recipient_id);
  const decisionOutcome = member(row.decision_outcome, TERMINAL_OUTCOMES);
  if (outboxId === null || recipientId === null || decisionOutcome === null) return null;
  return { outboxId, recipientId, decisionOutcome };
}

/** One row of `rebook_round_materialize`. Returned verbatim to the caller; never re-derived. */
export interface MaterializedRow {
  roundId: string;
  academyProfileId: string;
  outcome: string;
  recipientsConsidered: number;
  decisionsWritten: number;
  hasMore: boolean;
  lifecycle: string | null;
}

const MATERIALIZE_KEYS = [
  "round_id",
  "academy_profile_id",
  "outcome",
  "recipients_considered",
  "decisions_written",
  "has_more",
  "lifecycle",
] as const;

export function decodeMaterializeRow(row: unknown): MaterializedRow | null {
  if (!hasExactKeys(row, MATERIALIZE_KEYS)) return null;
  const roundId = uuid(row.round_id);
  const academyProfileId = uuid(row.academy_profile_id);
  const outcome = str(row.outcome);
  const considered = int(row.recipients_considered);
  const written = int(row.decisions_written);
  const hasMore = bool(row.has_more);
  const lifecycle = nullableStr(row.lifecycle);
  if (
    roundId === null || academyProfileId === null || outcome === null ||
    considered === null || written === null || hasMore === null || !lifecycle.ok
  ) return null;
  return {
    roundId,
    academyProfileId,
    outcome,
    recipientsConsidered: considered,
    decisionsWritten: written,
    hasMore,
    lifecycle: lifecycle.value,
  };
}

/** The single row of `rebook_member_open_dispatch_status_by_capability`. */
export interface CapabilityStatusRow {
  outcome: CapabilityStatusOutcome;
  transportState: TransportState | null;
  leaseGeneration: number | null;
  dispatchAuthorizedGeneration: number | null;
  firstDispatchAt: OpaqueTimestamp | null;
  uncertaintyDeadlineAt: OpaqueTimestamp | null;
  providerMessageId: string | null;
  legacyStatus: string | null;
  decisionOutcome: TerminalOutcome | null;
  refusalReason: string | null;
}

const CAPABILITY_STATUS_KEYS = [
  "outcome",
  "transport_state",
  "lease_generation",
  "dispatch_authorized_generation",
  "first_dispatch_at",
  "uncertainty_deadline_at",
  "provider_message_id",
  "legacy_status",
  "decision_outcome",
  "refusal_reason",
] as const;

export function decodeCapabilityStatusRow(row: unknown): CapabilityStatusRow | null {
  if (!hasExactKeys(row, CAPABILITY_STATUS_KEYS)) return null;
  const outcome = member(row.outcome, CAPABILITY_STATUS_OUTCOMES);
  if (outcome === null) return null;
  const transport = row.transport_state === null || row.transport_state === undefined
    ? null
    : member(row.transport_state, TRANSPORT_STATES);
  if ((row.transport_state !== null && row.transport_state !== undefined) && transport === null) {
    return null;
  }
  const decision = row.decision_outcome === null || row.decision_outcome === undefined
    ? null
    : member(row.decision_outcome, TERMINAL_OUTCOMES);
  if ((row.decision_outcome !== null && row.decision_outcome !== undefined) && decision === null) {
    return null;
  }
  const lease = row.lease_generation === null || row.lease_generation === undefined
    ? null
    : int(row.lease_generation);
  if ((row.lease_generation !== null && row.lease_generation !== undefined) && lease === null) {
    return null;
  }
  const authorized =
    row.dispatch_authorized_generation === null || row.dispatch_authorized_generation === undefined
      ? null
      : int(row.dispatch_authorized_generation);
  if (
    (row.dispatch_authorized_generation !== null &&
      row.dispatch_authorized_generation !== undefined) && authorized === null
  ) return null;
  const first = nullableTimestamp(row.first_dispatch_at);
  const deadline = nullableTimestamp(row.uncertainty_deadline_at);
  const messageId = nullableStr(row.provider_message_id);
  const legacy = nullableStr(row.legacy_status);
  const reason = nullableStr(row.refusal_reason);
  if (!first.ok || !deadline.ok || !messageId.ok || !legacy.ok || !reason.ok) return null;
  if (messageId.value !== null && messageId.value.length > PROVIDER_MESSAGE_ID_MAX) return null;
  return {
    outcome,
    transportState: transport,
    leaseGeneration: lease,
    dispatchAuthorizedGeneration: authorized,
    firstDispatchAt: first.value,
    uncertaintyDeadlineAt: deadline.value,
    providerMessageId: messageId.value,
    legacyStatus: legacy.value,
    decisionOutcome: decision,
    refusalReason: reason.value,
  };
}

/**
 * Decode an RPC result that must be a LIST of rows.
 *
 * A single unreadable row poisons the whole batch: the worker cannot tell which capability it just
 * failed to understand, and proceeding on the readable remainder would silently drop a leased row
 * that is now held by nobody's knowledge. `null` here is a run-level error by design.
 */
export function decodeRows<T>(
  data: unknown,
  decode: (row: unknown) => T | null,
): T[] | null {
  if (!Array.isArray(data)) return null;
  const out: T[] = [];
  for (const row of data) {
    const decoded = decode(row);
    if (decoded === null) return null;
    out.push(decoded);
  }
  return out;
}

/**
 * Decode an RPC result that must be EXACTLY ONE row.
 *
 * Every single-row surface in this contract returns exactly one row on every path — a refusal is a
 * row, not an empty set — so zero rows and two rows are both drift, and both fail closed.
 */
export function decodeSingleRow<T>(
  data: unknown,
  decode: (row: unknown) => T | null,
): T | null {
  if (!Array.isArray(data) || data.length !== 1) return null;
  return decode(data[0]);
}
