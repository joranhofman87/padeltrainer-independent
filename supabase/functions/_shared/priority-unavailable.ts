/**
 * ABC-26 — supplementary rebooking priority is UNAVAILABLE during containment.
 *
 * This is the single authority for that refusal. It is imported directly by the Edge functions and
 * re-exported to the browser by `src/lib/priorityUnavailable.ts`; it is deliberately NOT copied,
 * because the previous draft kept one schema per runtime and two hand-copied schemas drift exactly
 * where it matters — the version constant and the reason vocabulary.
 *
 * The decision covers EVERY class of supplementary priority:
 *
 *  - registered selections — an account is not proof of an academy relationship;
 *  - directly owned guests — ownership proves who may edit a row, not who is owed a seat ahead of
 *    everyone else; and
 *  - exclusion-derived second-bucket selections — those are registered accounts reached through the
 *    same withdrawn evidence, one step removed.
 *
 * Ordinary round creation with ZERO supplementary priority is unaffected and stays available.
 *
 * What replaces it is a purpose-bound, expiring OFFER built on canonical Player/U3 identity with
 * UUID offer/command identity, UUID idempotency, tenant-scoped server authorization, deterministic
 * concurrency, bounded queries, audit and recovery. Its schema is NOT chosen here. Whatever it
 * becomes, it never restores email/name/link/twin/person-equality identity.
 *
 * The contract is fail-closed by construction: a request carrying any supplementary priority is
 * refused unless the caller proves it speaks EXACTLY this version, and a refusal is never a
 * partial success.
 */

/** Exact supported version. Equality only — see `isSupportedPriorityProtocol`. */
export const PRIORITY_PROTOCOL_VERSION = 2 as const;

/** Every typed refusal this contract can emit. Anything else is malformed, not "unknown". */
export const PRIORITY_REFUSAL_REASONS = [
  /** Supplementary priority is unavailable for every class. The ordinary ABC-26 outcome. */
  'priority_unavailable',
  /** The caller did not prove it speaks this exact protocol version. */
  'unsupported_protocol_version',
  /** An id was blank or whitespace-only. */
  'blank_identifier',
  /** An id was not a UUID. */
  'invalid_identifier',
  /** `priorityPeople` / `priorityGuests` was present but not an array of strings. */
  'malformed_input',
  /** The same id appeared twice in one arm. Reported explicitly, never de-duplicated away. */
  'duplicate_identifier',
  /** More than MAX_PRIORITY_SUBMISSIONS entries in one arm. Never truncated. */
  'too_many_submitted',
] as const;
export type PriorityRefusalReason = (typeof PRIORITY_REFUSAL_REASONS)[number];

/** Hard cap per arm. Over it the request is refused; entries are counted, never sliced away. */
export const MAX_PRIORITY_SUBMISSIONS = 200;

/**
 * An honest report of what the caller sent. `submitted` counts RAW entries as supplied — before
 * de-duplication, before validation, before any cap — because the number the operator selected is
 * the number they must be told about.
 */
export interface PriorityArmReport {
  submitted: number;
  admitted: 0;
  refused: number;
}

export interface PriorityRefusal {
  version: typeof PRIORITY_PROTOCOL_VERSION;
  available: false;
  reason: PriorityRefusalReason;
  registered: PriorityArmReport;
  guest: PriorityArmReport;
  secondBucket: PriorityArmReport;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Canonical form for duplicate detection: trimmed and LOWER-CASED.
 *
 * A UUID is case-insensitive, so `A1B2…` and `a1b2…` are ONE identifier. Comparing them as raw
 * strings reported two distinct entries and let a duplicated selection through as if it were two
 * different people — the exact silent normalisation this accounting exists to refuse. A series key
 * is `<locationUuid>|<trainerUuid>|<weekday>|<hh:mm>`: UUIDs and digits only, so the same rule is
 * correct there and nothing case-significant is being folded away.
 */
const canonical = (v: string): string => v.trim().toLowerCase();

/**
 * EXACT version equality. `>= VERSION` was wrong in both directions: a FUTURE client may have a
 * different meaning for the same field names, and treating it as compatible is how a silent
 * mismatch ships. Missing, stale, future and malformed all fail closed here.
 */
export function isSupportedPriorityProtocol(v: unknown): boolean {
  return v === PRIORITY_PROTOCOL_VERSION;
}

const arm = (submitted: number): PriorityArmReport => ({ submitted, admitted: 0, refused: submitted });

/** Raw request shape, exactly as it may arrive from any client version. */
export interface PriorityRequestInput {
  priorityPeople?: unknown;
  priorityGuests?: unknown;
  secondBucketSeriesKeys?: unknown;
  priorityContractVersion?: unknown;
}

export type PriorityParse =
  | { kind: 'empty' }
  | { kind: 'refused'; refusal: PriorityRefusal };

/** Count raw entries without validating them, so a refusal can still be honest about the total. */
function rawCount(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

/**
 * First structural problem in one arm, or null. Order is deterministic.
 *
 * `requireUuid` distinguishes the two arm shapes: `priorityPeople` / `priorityGuests` carry bare
 * UUIDs, while `secondBucketSeriesKeys` carries composite series keys. Both are size-capped on the
 * RAW count, both refuse blanks, and both refuse duplicates under the canonical form — an arm whose
 * duplicates were tolerated would understate what the operator actually submitted.
 */
function armProblem(v: unknown, requireUuid: boolean): PriorityRefusalReason | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) return 'malformed_input';
  // RAW length, before any de-duplication: over the cap the request is refused, never sliced.
  if (v.length > MAX_PRIORITY_SUBMISSIONS) return 'too_many_submitted';
  const seen = new Set<string>();
  for (const entry of v) {
    if (typeof entry !== 'string') return 'malformed_input';
    const trimmed = entry.trim();
    if (trimmed.length === 0) return 'blank_identifier';
    if (requireUuid && !UUID_RE.test(trimmed)) return 'invalid_identifier';
    const key = canonical(trimmed);
    if (seen.has(key)) return 'duplicate_identifier';
    seen.add(key);
  }
  return null;
}

/**
 * Parse a request's supplementary-priority input ONCE, before any write.
 *
 * Returns `empty` only when every arm is genuinely absent or an empty array — the one case in
 * which a round may proceed. Everything else is a typed, no-write refusal that reports the raw
 * counts the caller submitted.
 *
 * Structural problems are reported ahead of `priority_unavailable`: an operator whose selection was
 * malformed needs to know that, and a caller sending garbage should not be told the feature merely
 * happens to be switched off.
 */
export function parsePriorityRequest(input: PriorityRequestInput): PriorityParse {
  const registeredRaw = rawCount(input.priorityPeople);
  const guestRaw = rawCount(input.priorityGuests);
  const bucketRaw = rawCount(input.secondBucketSeriesKeys);

  const reports = {
    registered: arm(registeredRaw),
    guest: arm(guestRaw),
    secondBucket: arm(bucketRaw),
  };
  const refuse = (reason: PriorityRefusalReason): PriorityParse => ({
    kind: 'refused',
    refusal: { version: PRIORITY_PROTOCOL_VERSION, available: false, reason, ...reports },
  });

  // Non-array-but-present is malformed even when it would otherwise count as zero.
  for (const v of [input.priorityPeople, input.priorityGuests, input.secondBucketSeriesKeys]) {
    if (v !== undefined && v !== null && !Array.isArray(v)) return refuse('malformed_input');
  }

  const anySubmitted = registeredRaw + guestRaw + bucketRaw > 0;
  if (!anySubmitted) return { kind: 'empty' };

  // Structural faults first, in a fixed arm order so the answer is deterministic. The second-bucket
  // arm carries composite SERIES keys rather than bare UUIDs, so it is checked with the same rules
  // minus the UUID shape — including the duplicate rule, which an earlier draft omitted entirely.
  for (const [v, requireUuid] of [
    [input.priorityPeople, true],
    [input.priorityGuests, true],
    [input.secondBucketSeriesKeys, false],
  ] as Array<[unknown, boolean]>) {
    const problem = armProblem(v, requireUuid);
    if (problem) return refuse(problem);
  }

  // Structurally fine, and still unavailable — but only for a caller that speaks this exact
  // protocol. A caller that does not cannot be told anything it will understand.
  if (!isSupportedPriorityProtocol(input.priorityContractVersion)) {
    return refuse('unsupported_protocol_version');
  }
  return refuse('priority_unavailable');
}

// ── Decoding a refusal that arrived over the wire ───────────────────────────────────────────
//
// The previous guard checked `version`, `available` and `reason` and stopped there, while every
// consumer went on to read `refusal.registered.submitted + refusal.guest.submitted + ...`. A body
// that passed the guard with a missing, non-object, negative, fractional or NaN arm therefore
// produced `NaN` — or threw — inside the component that was supposed to be reporting a refusal.
// So the arms are part of the contract and are decoded here, once, by the same authority.

const REFUSAL_KEYS = ['version', 'available', 'reason', 'registered', 'guest', 'secondBucket'] as const;
const ARM_KEYS = ['submitted', 'admitted', 'refused'] as const;

/** A count the protocol may carry: a finite, non-negative, exact integer within Number's safe range. */
function isSafeCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function hasExactKeys(o: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(o);
  return actual.length === expected.length && expected.every((k) => Object.prototype.hasOwnProperty.call(o, k));
}

/**
 * Decode ONE arm report. Every invariant the emitter promises is re-checked on receipt:
 * `admitted` is 0 (nothing is ever admitted under containment) and `refused` equals `submitted`
 * (a refusal is never a partial success). A body that says otherwise is not a refusal this
 * contract emitted, and is rejected rather than displayed.
 */
function parseArm(v: unknown): PriorityArmReport | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!hasExactKeys(o, ARM_KEYS)) return null;
  if (!isSafeCount(o.submitted) || !isSafeCount(o.admitted) || !isSafeCount(o.refused)) return null;
  if (o.admitted !== 0) return null;
  if (o.refused !== o.submitted) return null;
  return { submitted: o.submitted, admitted: 0, refused: o.refused };
}

export type PriorityRefusalParse =
  | { ok: true; refusal: PriorityRefusal; totalSubmitted: number }
  | { ok: false };

/**
 * The ONE runtime decoder for a refusal received from the server.
 *
 * Strict on purpose: exact key set, exact protocol version (never `>=`), `available === false`, a
 * reason drawn from the enum, and three fully-valid arm reports. Anything else returns `{ok:false}`
 * and the caller must treat the result as UNKNOWN — never as "a refusal with zero counts", which
 * would be a fabricated accounting of something we could not read.
 *
 * `totalSubmitted` is computed here, so no consumer has to reach into the arms to add them up.
 */
export function parsePriorityRefusal(v: unknown): PriorityRefusalParse {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false };
  const o = v as Record<string, unknown>;
  if (!hasExactKeys(o, REFUSAL_KEYS)) return { ok: false };
  if (o.version !== PRIORITY_PROTOCOL_VERSION) return { ok: false };
  if (o.available !== false) return { ok: false };
  if (typeof o.reason !== 'string') return { ok: false };
  if (!(PRIORITY_REFUSAL_REASONS as readonly string[]).includes(o.reason)) return { ok: false };

  const registered = parseArm(o.registered);
  const guest = parseArm(o.guest);
  const secondBucket = parseArm(o.secondBucket);
  if (!registered || !guest || !secondBucket) return { ok: false };

  const totalSubmitted = registered.submitted + guest.submitted + secondBucket.submitted;
  if (!Number.isSafeInteger(totalSubmitted)) return { ok: false };

  return {
    ok: true,
    refusal: {
      version: PRIORITY_PROTOCOL_VERSION,
      available: false,
      reason: o.reason as PriorityRefusalReason,
      registered,
      guest,
      secondBucket,
    },
    totalSubmitted,
  };
}

/**
 * Is this a refusal the caller must surface rather than retry? All of them are.
 * Delegates to the decoder so there is exactly ONE definition of a valid refusal.
 */
export function isPriorityRefusal(v: unknown): v is PriorityRefusal {
  return parsePriorityRefusal(v).ok;
}
