/**
 * ABC-27 / D7 — the BROWSER-side wire contract for the operator round-command surface.
 *
 * This is the single authority for what the five `*_as_actor` wrappers can say and how their rows
 * are read. It holds the closed status vocabularies, the `bytea` hex codec, and strict decoders —
 * and no transport, no policy and no UI.
 *
 * WHY IT LIVES IN `src/lib` AND NOT IN `_shared`. `supabase/functions/_shared/priority-unavailable.ts`
 * is shared because BOTH runtimes speak that contract. This one is browser-only by construction:
 * the operator surface is reached by a DIRECT authenticated PostgREST RPC and never through an edge
 * function, because `requireUser` returns a SERVICE-ROLE client on every path — and under
 * `service_role` `auth.uid()` is NULL, so every wrapper would return its closed `refused` row. An
 * edge function physically cannot act as an operator here, so nothing on that side needs this file.
 *
 * THE FOUR-HOP PROTOCOL these decoders serve, in order:
 *
 *   PROBE    preview with `p_target_slot_ids := '{}'` → `invalid_request` plus the server's
 *            `occurrence_count`. Zero writes. This is how the caller learns HOW MANY identities to
 *            mint without inventing the number itself.
 *   MINT     `crypto.randomUUID()` × `occurrence_count`, plus one `command_id`.
 *   PREVIEW  the same call with the minted identities → `previewed` + `review_fingerprint`.
 *   APPLY    identical arguments + `command_id` + `review_fingerprint`.
 *
 * RETRY IS THE SAME `command_id`, UNCHANGED, FOREVER. Same UUID + same payload → `replayed` with
 * the stored receipt. Same UUID + different payload → `command_payload_mismatch`, zero mutation. A
 * fresh UUID on retry is how one operator action becomes two rounds, so nothing here will mint one.
 *
 * EVERY DECODER FAILS CLOSED. An unreadable row is `unknown` — never "a refusal with empty counts",
 * which would be a fabricated report of something we could not read, and never a success.
 */

/** The exact contract version the wrappers demand. Equality only — never a range. */
export const ABC27_WIRE_VERSION = 'abc27.wire.v1' as const;

// ── The closed vocabularies ──────────────────────────────────────────────────────────────────

/**
 * `rebook_round_statuses()` — the closed vocabulary shared by the command, the driver and this
 * contract. Anything outside it is DRIFT, not an unknown state.
 */
export const ROUND_COMMAND_STATUSES = [
  'applied',
  'replayed',
  'invalid_request',
  'command_tenant_mismatch',
  'command_kind_mismatch',
  'command_payload_mismatch',
  'round_not_found',
  'round_closed',
  'round_legacy_review_required',
  'round_command_in_progress',
  'child_not_found',
  'child_not_draft',
  'child_already_in_round',
  'duplicate_sibling_series',
  'expected_version_mismatch',
  'session_price_refused',
  'incoherent_source',
  'review_fingerprint_mismatch',
  'source_drift',
] as const;
export type RoundCommandStatus = typeof ROUND_COMMAND_STATUSES[number];

/**
 * `refused` is the WRAPPER's own closed answer and is deliberately NOT in the status vocabulary
 * above: the core never emits it. It means the caller was not authorized for this academy, or the
 * transaction isolation was unsupported, or the contract version did not match — and all three
 * produce the IDENTICAL row on purpose, so the surface cannot be used to tell them apart.
 */
export const WRAPPER_REFUSED = 'refused' as const;

/** What a PREVIEW can answer: the success arm, every typed refusal, or the wrapper's refusal. */
export const PREVIEW_STATUSES = ['previewed', ...ROUND_COMMAND_STATUSES, WRAPPER_REFUSED] as const;
export type PreviewStatus = typeof PREVIEW_STATUSES[number];

/** What an APPLY can answer. `previewed` is not among them. */
export const APPLY_STATUSES = [...ROUND_COMMAND_STATUSES, WRAPPER_REFUSED] as const;
export type ApplyStatus = typeof APPLY_STATUSES[number];

/** The apply gate carried beside a review. A priced intent is reviewable but not appliable. */
export const APPLY_ELIGIBILITIES = ['eligible', 'refused_session_price'] as const;
export type ApplyEligibility = typeof APPLY_ELIGIBILITIES[number];

/** What a command-status or fingerprint lookup can answer. */
export const LOOKUP_STATUSES = ['found', WRAPPER_REFUSED] as const;
export type LookupStatus = typeof LOOKUP_STATUSES[number];

/** The closed lifecycle transitions the lifecycle command may drive. */
export const LIFECYCLE_TRANSITIONS = ['open->closed', 'closed->archived', 'archived->closed', 'closed->open'] as const;
export type LifecycleTransition = typeof LIFECYCLE_TRANSITIONS[number];

/** The two command kinds the normalized apply surface accepts. */
export const COMMAND_KINDS = ['create', 'extend'] as const;
export type CommandKind = typeof COMMAND_KINDS[number];

/**
 * The statuses that mean the round EXISTS as the operator asked for it.
 *
 * `replayed` is here because a replay is a success: it returns the stored receipt of the command
 * that already applied. Treating it as a failure is how a retried apply becomes a second round.
 */
export const APPLY_SUCCESS_STATUSES = ['applied', 'replayed'] as const;
export const isApplySuccess = (s: ApplyStatus): boolean =>
  (APPLY_SUCCESS_STATUSES as readonly string[]).includes(s);

// ── The `bytea` codec ────────────────────────────────────────────────────────────────────────

/**
 * PostgREST renders `bytea` as PostgreSQL's `hex` text output — a JSON string `"\\x<hex>"` — and
 * on input casts that same string back through bytea's text input function. So the WIRE FORM IS
 * THE STRING, and the correct handling is to keep it exactly as received and hand it back
 * unchanged.
 *
 * NOTHING HERE DECODES TO BYTES. A `review_fingerprint` is a server-derived opaque token; the
 * browser's only jobs are to recognise a well-formed one and to return it verbatim. Converting to
 * a byte array and back would introduce an encoding step that can only ever lose, and a
 * fingerprint that changes by one byte fails the apply's re-derivation with `source_drift` — a
 * message about the operator's sources, for a defect in this file.
 */
const BYTEA_HEX_RE = /^\\x(?:[0-9a-f]{2})*$/i;

/** A server-issued `bytea` in its wire form. Branded so a raw string cannot be passed by mistake. */
export type ByteaHex = string & { readonly __byteaHex: unique symbol };

/** The exact octet length of a server fingerprint: sha256. Enforced, never assumed. */
export const REVIEW_FINGERPRINT_OCTETS = 32;

export function isByteaHex(v: unknown): v is ByteaHex {
  return typeof v === 'string' && BYTEA_HEX_RE.test(v);
}

/** Octet length of a wire-form bytea: two hex characters per octet, after the `\x` prefix. */
export const byteaOctetLength = (v: ByteaHex): number => (v.length - 2) / 2;

/**
 * Read a `review_fingerprint` from a row.
 *
 * Returns `null` for anything that is not a well-formed 32-octet wire-form bytea — including a
 * present-but-wrong-length value, which the apply surface itself refuses as
 * `review_fingerprint_mismatch`. Catching it here means the caller never spends an apply on a
 * fingerprint that could not possibly match.
 */
export function readReviewFingerprint(v: unknown): ByteaHex | null {
  if (!isByteaHex(v)) return null;
  return byteaOctetLength(v) === REVIEW_FINGERPRINT_OCTETS ? v : null;
}

// ── THE CANONICAL RECEIPT ────────────────────────────────────────────────────────────────────
//
// D7 TERMINAL CLOSURE. `rebook_round_commands` freezes the EXACT bytes of the receipt the first
// apply returned, plus a SHA-256 over exactly those bytes, and the table's own CHECK constraints
// tie the three representations together so a row cannot disagree with itself
// (`…abc27…:3520-3540`). That is what makes a recovered receipt usable as evidence rather than as
// a hopeful guess.
//
// The client verifies the digest anyway. Not because it distrusts the constraint — it cannot be
// violated — but because the bytes reach us over a transport, and a receipt that arrived corrupted
// would otherwise be parsed into confident, wrong child ids and drained against them.

/** The receipt a create or extend command committed. */
export interface CommandReceipt {
  version: string;
  kind: string;
  roundId: string;
  commandId: string;
  childCycleIds: string[];
  count: number;
  occurrenceCount: number;
  claimCount: number;
}

const RECEIPT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Wire-form bytea (`\x…`) to bytes. Returns null for anything that is not one. */
export function byteaToBytes(v: ByteaHex): Uint8Array | null {
  const hex = v.slice(2);
  if (hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isInteger(byte)) return null;
    out[i] = byte;
  }
  return out;
}

const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/**
 * Verify a recovered receipt and read it.
 *
 * EVERY CHECK IS A REFUSAL, NEVER A REPAIR. A receipt that does not hash to its own digest, does
 * not parse, is not the version we understand, or does not describe the round and command the row
 * says it describes, is `null` — and the caller reports that it could not decide, which is the
 * honest answer. Draining against half-understood bytes is the failure this whole path exists to
 * avoid.
 */
export async function readCommandReceipt(
  canonical: ByteaHex,
  digest: ByteaHex,
  expect: { roundId: string; commandId: string },
): Promise<CommandReceipt | null> {
  const bytes = byteaToBytes(canonical);
  const want = byteaToBytes(digest);
  if (!bytes || !want || want.length !== REVIEW_FINGERPRINT_OCTETS) return null;
  if (typeof globalThis.crypto?.subtle?.digest !== 'function') return null;
  const got = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  if (toHex(got) !== toHex(want)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const r = parsed as Record<string, unknown>;
  if (r.v !== 'abc27.receipt.v1') return null;
  if (typeof r.kind !== 'string' || !COMMAND_KINDS.includes(r.kind as never)) return null;
  if (typeof r.roundId !== 'string' || r.roundId !== expect.roundId) return null;
  if (typeof r.commandId !== 'string' || r.commandId !== expect.commandId) return null;
  if (!Array.isArray(r.children)) return null;
  const children = r.children.filter((x): x is string => typeof x === 'string' && RECEIPT_UUID_RE.test(x));
  if (children.length !== r.children.length) return null;
  const n = count(r.count);
  const occ = count(r.occurrenceCount);
  const claims = count(r.claimCount);
  if (n === null || occ === null || claims === null) return null;
  // The receipt's own count and its own list must agree, for the reason the apply decoder checks
  // the same pair: one of them is not what we think it is otherwise.
  if (n !== children.length) return null;
  return {
    version: r.v,
    kind: r.kind,
    roundId: r.roundId,
    commandId: r.commandId,
    childCycleIds: children,
    count: n,
    occurrenceCount: occ,
    claimCount: claims,
  };
}

// ── Strict decoding primitives ───────────────────────────────────────────────────────────────

function hasExactKeys(row: unknown, keys: readonly string[]): row is Record<string, unknown> {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  const actual = Object.keys(row as Record<string, unknown>);
  return actual.length === keys.length
    && keys.every((k) => Object.prototype.hasOwnProperty.call(row, k));
}

function member<T extends string>(v: unknown, vocabulary: readonly T[]): T | null {
  return typeof v === 'string' && (vocabulary as readonly string[]).includes(v) ? v as T : null;
}

/** A count the protocol may carry: a finite, non-negative, exact integer. Never coerced. */
function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidOrNull(v: unknown): { ok: true; value: string | null } | { ok: false } {
  if (v === null || v === undefined) return { ok: true, value: null };
  return typeof v === 'string' && UUID_RE.test(v) ? { ok: true, value: v } : { ok: false };
}

function textOrNull(v: unknown): { ok: true; value: string | null } | { ok: false } {
  if (v === null || v === undefined) return { ok: true, value: null };
  return typeof v === 'string' ? { ok: true, value: v } : { ok: false };
}

function byteaOrNull(v: unknown): { ok: true; value: ByteaHex | null } | { ok: false } {
  if (v === null || v === undefined) return { ok: true, value: null };
  return isByteaHex(v) ? { ok: true, value: v } : { ok: false };
}

// ── The decoded row shapes ───────────────────────────────────────────────────────────────────

export interface PreviewRow {
  status: PreviewStatus;
  contractVersion: string | null;
  reviewFingerprint: ByteaHex | null;
  applyEligibility: ApplyEligibility | null;
  childCount: number;
  sourceCount: number;
  cohortTotal: number;
  /** THE NUMBER OF TARGET-SLOT IDENTITIES THE CALLER MUST MINT. Server-derived, never guessed. */
  occurrenceCount: number;
  claimCount: number;
  holidayRowCount: number;
  exclusionRangeCount: number;
  diagnosticChild: string | null;
  diagnosticField: string | null;
}

const PREVIEW_KEYS = [
  'status', 'contract_version', 'review_fingerprint', 'apply_eligibility',
  'child_count', 'source_count', 'cohort_total', 'occurrence_count', 'claim_count',
  'holiday_row_count', 'exclusion_range_count', 'diagnostic_child', 'diagnostic_field',
] as const;

export function decodePreviewRow(row: unknown): PreviewRow | null {
  if (!hasExactKeys(row, PREVIEW_KEYS)) return null;
  const status = member(row.status, PREVIEW_STATUSES);
  if (status === null) return null;
  const contractVersion = textOrNull(row.contract_version);
  const fingerprint = byteaOrNull(row.review_fingerprint);
  const eligibility = row.apply_eligibility === null || row.apply_eligibility === undefined
    ? null : member(row.apply_eligibility, APPLY_ELIGIBILITIES);
  if ((row.apply_eligibility !== null && row.apply_eligibility !== undefined) && eligibility === null) {
    return null;
  }
  const childCount = count(row.child_count);
  const sourceCount = count(row.source_count);
  const cohortTotal = count(row.cohort_total);
  const occurrenceCount = count(row.occurrence_count);
  const claimCount = count(row.claim_count);
  const holidayRowCount = count(row.holiday_row_count);
  const exclusionRangeCount = count(row.exclusion_range_count);
  const diagnosticChild = uuidOrNull(row.diagnostic_child);
  const diagnosticField = textOrNull(row.diagnostic_field);
  if (
    !contractVersion.ok || !fingerprint.ok || !diagnosticChild.ok || !diagnosticField.ok
    || childCount === null || sourceCount === null || cohortTotal === null
    || occurrenceCount === null || claimCount === null
    || holidayRowCount === null || exclusionRangeCount === null
  ) return null;
  // A `previewed` row MUST carry both halves of the review, or there is nothing to apply against.
  if (status === 'previewed') {
    if (readReviewFingerprint(fingerprint.value) === null) return null;
    if (eligibility === null) return null;
  }
  return {
    status,
    contractVersion: contractVersion.value,
    reviewFingerprint: fingerprint.value,
    applyEligibility: eligibility,
    childCount,
    sourceCount,
    cohortTotal,
    occurrenceCount,
    claimCount,
    holidayRowCount,
    exclusionRangeCount,
    diagnosticChild: diagnosticChild.value,
    diagnosticField: diagnosticField.value,
  };
}

export interface ApplyRow {
  status: ApplyStatus;
  roundId: string | null;
  commandId: string | null;
  childCount: number;
  occurrenceCount: number;
  claimCount: number;
  receiptCanonical: ByteaHex | null;
  receiptDigest: ByteaHex | null;
  detail: unknown;
  roundVersion: number | null;
}

const APPLY_KEYS = [
  'status', 'round_id', 'command_id', 'child_count', 'occurrence_count', 'claim_count',
  'receipt_canonical', 'receipt_digest', 'detail', 'round_version',
] as const;

export function decodeApplyRow(row: unknown): ApplyRow | null {
  if (!hasExactKeys(row, APPLY_KEYS)) return null;
  const status = member(row.status, APPLY_STATUSES);
  if (status === null) return null;
  const roundId = uuidOrNull(row.round_id);
  const commandId = uuidOrNull(row.command_id);
  const childCount = count(row.child_count);
  const occurrenceCount = count(row.occurrence_count);
  const claimCount = count(row.claim_count);
  const receiptCanonical = byteaOrNull(row.receipt_canonical);
  const receiptDigest = byteaOrNull(row.receipt_digest);
  const roundVersion = row.round_version === null || row.round_version === undefined
    ? null : count(row.round_version);
  if ((row.round_version !== null && row.round_version !== undefined) && roundVersion === null) {
    return null;
  }
  if (
    !roundId.ok || !commandId.ok || !receiptCanonical.ok || !receiptDigest.ok
    || childCount === null || occurrenceCount === null || claimCount === null
  ) return null;
  // A SUCCESSFUL apply MUST name the round it produced and carry its receipt. Anything less is a
  // half-populated answer, and "created" inferred from an incomplete response is exactly the
  // failure mode that leaves an operator retrying a command that already succeeded.
  if (isApplySuccess(status)) {
    if (roundId.value === null || receiptCanonical.value === null || receiptDigest.value === null) {
      return null;
    }
  }
  return {
    status,
    roundId: roundId.value,
    commandId: commandId.value,
    childCount,
    occurrenceCount,
    claimCount,
    receiptCanonical: receiptCanonical.value,
    receiptDigest: receiptDigest.value,
    detail: row.detail ?? null,
    roundVersion,
  };
}

export interface LifecycleRow {
  status: ApplyStatus;
  roundId: string | null;
  commandId: string | null;
  affectedCycles: number;
  receiptCanonical: ByteaHex | null;
  receiptDigest: ByteaHex | null;
}

const LIFECYCLE_KEYS = [
  'status', 'round_id', 'command_id', 'affected_cycles', 'receipt_canonical', 'receipt_digest',
] as const;

export function decodeLifecycleRow(row: unknown): LifecycleRow | null {
  if (!hasExactKeys(row, LIFECYCLE_KEYS)) return null;
  const status = member(row.status, APPLY_STATUSES);
  if (status === null) return null;
  const roundId = uuidOrNull(row.round_id);
  const commandId = uuidOrNull(row.command_id);
  const affectedCycles = count(row.affected_cycles);
  const receiptCanonical = byteaOrNull(row.receipt_canonical);
  const receiptDigest = byteaOrNull(row.receipt_digest);
  if (!roundId.ok || !commandId.ok || !receiptCanonical.ok || !receiptDigest.ok
    || affectedCycles === null) return null;
  if (isApplySuccess(status) && (roundId.value === null || receiptCanonical.value === null)) {
    return null;
  }
  return {
    status,
    roundId: roundId.value,
    commandId: commandId.value,
    affectedCycles,
    receiptCanonical: receiptCanonical.value,
    receiptDigest: receiptDigest.value,
  };
}

export interface CommandStatusRow {
  status: LookupStatus;
  commandKind: CommandKind | null;
  roundId: string | null;
  receiptCanonical: ByteaHex | null;
  receiptDigest: ByteaHex | null;
  appliedAt: string | null;
}

const STATUS_KEYS = [
  'status', 'command_kind', 'round_id', 'receipt_canonical', 'receipt_digest', 'applied_at',
] as const;

export function decodeCommandStatusRow(row: unknown): CommandStatusRow | null {
  if (!hasExactKeys(row, STATUS_KEYS)) return null;
  const status = member(row.status, LOOKUP_STATUSES);
  if (status === null) return null;
  // The recovery surfaces answer for `import` receipts too, whose kind is outside the operator
  // vocabulary — but those rows are excluded by the core's actor scoping, so a kind arriving here
  // that is not `create`/`extend` is drift rather than an expected shape.
  const kind = row.command_kind === null || row.command_kind === undefined
    ? null : member(row.command_kind, COMMAND_KINDS);
  if ((row.command_kind !== null && row.command_kind !== undefined) && kind === null) return null;
  const roundId = uuidOrNull(row.round_id);
  const receiptCanonical = byteaOrNull(row.receipt_canonical);
  const receiptDigest = byteaOrNull(row.receipt_digest);
  const appliedAt = textOrNull(row.applied_at);
  if (!roundId.ok || !receiptCanonical.ok || !receiptDigest.ok || !appliedAt.ok) return null;
  if (status === 'found' && roundId.value === null) return null;
  return {
    status,
    commandKind: kind,
    roundId: roundId.value,
    receiptCanonical: receiptCanonical.value,
    receiptDigest: receiptDigest.value,
    appliedAt: appliedAt.value,
  };
}

export interface CommandLookupRow extends CommandStatusRow {
  commandId: string | null;
}

const LOOKUP_KEYS = [
  'status', 'command_kind', 'round_id', 'command_id',
  'receipt_canonical', 'receipt_digest', 'applied_at',
] as const;

export function decodeCommandLookupRow(row: unknown): CommandLookupRow | null {
  if (!hasExactKeys(row, LOOKUP_KEYS)) return null;
  const { command_id: commandId, ...rest } = row as Record<string, unknown>;
  const base = decodeCommandStatusRow(rest);
  if (base === null) return null;
  const id = uuidOrNull(commandId);
  if (!id.ok) return null;
  if (base.status === 'found' && id.value === null) return null;
  return { ...base, commandId: id.value };
}

/**
 * Every wrapper returns EXACTLY ONE row on every path — a refusal is a row, not an empty set — so
 * zero rows and two rows are both drift and both fail closed.
 */
export function decodeSingle<T>(data: unknown, decode: (row: unknown) => T | null): T | null {
  if (!Array.isArray(data) || data.length !== 1) return null;
  return decode(data[0]);
}
