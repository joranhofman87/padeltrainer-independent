/**
 * D7 — the event-specific SINGLE-ATTEMPT observed-send boundary for
 * `rebook_member_open_player`.
 *
 * WHY THIS EXISTS INSTEAD OF `sendResendEmail`. The shared helper retries up to
 * `RESEND_MAX_ATTEMPTS = 3` internally, collapses every outcome into
 * `{ ok, error, retryable }`, and copies the provider's free-text `message` into `error`.
 * All three are disqualifying here:
 *
 *   1. an internal retry is a blind retry after acceptance uncertainty — forbidden;
 *   2. a collapsed verdict is a CLIENT-side classification, and PostgreSQL is the sole
 *      classifier and decision authority;
 *   3. provider free text must never be stored, classified, logged or returned.
 *
 * The generic helper is deliberately NOT modified: every non-D7 caller keeps its exact
 * current behaviour.
 *
 * WHAT THIS RETURNS. Raw, bounded observations only — never a verdict. The database
 * derives the six-value classifier from this tuple; nothing here may pre-judge it.
 *
 * ATTEMPT CEILING. At most ONE `fetch` per database-authorized generation. A crash before
 * `fetch` may produce zero calls; once `fetch` is reached it happens exactly once and is
 * never retried internally. This is a safety ceiling, not a liveness claim.
 */

/** Exactly the owner-approved abort/timeout budget. */
export const OBSERVED_SEND_TIMEOUT_MS = 20_000;

/** Owner-approved internal safety ceilings. NOT claims about provider-published maxima. */
export const PROVIDER_ERROR_CODE_MAX = 128;
export const PROVIDER_MESSAGE_ID_MAX = 128;
export const IDEMPOTENCY_KEY_MAX = 256;

export const RESEND_SEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * The closed transport-fault vocabulary. It describes what the CLIENT observed about the
 * transport, never what the provider decided.
 *
 * `unreadable_ack` is reserved for the one case where acceptance is genuinely unknowable:
 * a 2xx whose body could not be read, so the message ID that would confirm acceptance is
 * unavailable. A NON-2xx response is a definite non-acceptance even when its body is
 * unreadable, so it reports `none` and lets the database classify it — routing it through
 * `unreadable_ack` would launder a definite rejection into acceptance-uncertainty and
 * could open a same-key re-POST that the provider never invited.
 */
export type TransportFault = "none" | "timeout" | "network" | "unreadable_ack";

export const TRANSPORT_FAULTS: readonly TransportFault[] = [
  "none",
  "timeout",
  "network",
  "unreadable_ack",
] as const;

/** Zero-call refusals. These are decided BEFORE `fetch`, so no provider call occurred. */
export type ObservedSendRefusal = "idempotency_key_invalid" | "request_bytes_invalid";

/**
 * `observed: true` means exactly one `fetch` was performed and the tuple describes it.
 * `observed: false` means ZERO fetches were performed.
 */
export type ObservedSendResult =
  | {
    observed: true;
    httpStatus: number | null;
    providerErrorCode: string | null;
    providerMessageId: string | null;
    transportFault: TransportFault;
    /**
     * STRUCTURAL VALIDITY OF THE RAW ENVELOPE — never an outcome classification.
     *
     * It answers exactly one question: did every provider field that was PRESENT obey the
     * approved type, character set and bound? It says nothing about accepted, retryable,
     * permanent or uncertain; PostgreSQL remains the sole classifier.
     *
     * WHY IT IS LOAD-BEARING. Without it, "the provider honestly sent no error code" and
     * "the provider sent a code we could not safely accept" both arrive as NULL. A 5xx or
     * 409 carrying a malformed or over-bound field would then be indistinguishable from a
     * clean one, flow into ordinary acceptance-uncertainty handling, and could later
     * satisfy the same-key re-POST arm — a provider call authorized by an observation we
     * never actually understood.
     *
     * `false` means the database must fail closed: invariant fault -> configuration hold,
     * no decision, no retry consumed, and neither ordinary resend nor same-key re-POST.
     *
     * An ABSENT optional field is valid. An unreadable body is valid too: "we could not
     * read the acknowledgement" is an approved observation shape, not a malformed field.
     */
    envelopeStructurallyValid: boolean;
  }
  | { observed: false; refusal: ObservedSendRefusal };

/** The already-frozen dispatch inputs, handed over verbatim by `begin_dispatch`. */
export interface FrozenDispatchRequest {
  /** Non-empty, <= 256 chars. Reused unchanged so a re-POST is deduplicated by the provider. */
  idempotencyKey: string;
  /** The EXACT request body bytes frozen at enqueue. Never re-serialized here. */
  requestBytes: string;
}

export interface ObservedSendDeps {
  /** Injected so the boundary is exercised directly; production passes global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Printable ASCII, no control characters, no whitespace — safe for a header value. */
const IDEMPOTENCY_KEY_RE = /^[\x21-\x7E]{1,256}$/;

/** A machine slug: starts alphanumeric, then alphanumerics plus `_ . -`. */
const PROVIDER_ERROR_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** Safe ASCII identifier: starts alphanumeric, then alphanumerics plus a small punctuation set. */
const PROVIDER_MESSAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@=+-]{0,127}$/;

/** A bounded field reading: the safe value (or NULL) plus whether the raw field obeyed the shape. */
interface BoundedField {
  value: string | null;
  /** False only when the field was PRESENT and violated type, character set or bound. */
  valid: boolean;
}

/** An honestly absent optional field: no value, and structurally valid. */
const ABSENT: BoundedField = { value: null, valid: true };

/**
 * Read a provider field against its approved shape and bound.
 *
 * Three outcomes, and they must stay distinguishable:
 *   absent (`undefined`/`null`)        -> { null,  valid: true  }  the provider sent nothing
 *   present and within the approved bound -> { value, valid: true  }
 *   present but wrong-type/malformed/unsafe/over-bound -> { null, valid: false }
 *
 * The invalid case returns NO unsafe bytes: the offending value is dropped, never truncated
 * (truncating would invent a code the provider never sent) and never re-labelled as
 * `unreadable_ack` (that would move a definite outcome into acceptance uncertainty and could
 * open a same-key re-POST). The `valid: false` signal is what lets the database fail closed
 * instead of treating it as "no code supplied".
 */
function boundedField(value: unknown, pattern: RegExp): BoundedField {
  if (value === undefined || value === null) return ABSENT;
  if (typeof value !== "string") return { value: null, valid: false };
  return pattern.test(value) ? { value, valid: true } : { value: null, valid: false };
}

/**
 * Perform at most one observed provider call and return the raw bounded observation tuple.
 *
 * This function never classifies, never retries, never logs, and never returns provider
 * free text. It does not decide whether the recipient was reached — only the database does.
 */
export async function observeSingleSend(
  apiKey: string,
  frozen: FrozenDispatchRequest,
  deps: ObservedSendDeps = {},
): Promise<ObservedSendResult> {
  // ── Pre-fetch validation. A refusal here performs ZERO calls, which is materially
  //    different from "a call was made and we do not know the outcome". The worker must be
  //    able to tell those apart, so they are different discriminants.
  if (
    typeof frozen.idempotencyKey !== "string" ||
    frozen.idempotencyKey.length === 0 ||
    frozen.idempotencyKey.length > IDEMPOTENCY_KEY_MAX ||
    !IDEMPOTENCY_KEY_RE.test(frozen.idempotencyKey)
  ) {
    return { observed: false, refusal: "idempotency_key_invalid" };
  }
  if (typeof frozen.requestBytes !== "string" || frozen.requestBytes.length === 0) {
    return { observed: false, refusal: "request_bytes_invalid" };
  }

  const doFetch = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, OBSERVED_SEND_TIMEOUT_MS);

  let res: Response;
  try {
    // THE ONE CALL. There is no loop around this and no second call site in this module.
    res = await doFetch(RESEND_SEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": frozen.idempotencyKey,
      },
      body: frozen.requestBytes,
      signal: controller.signal,
    });
  } catch {
    // The error object is deliberately not inspected: it can carry provider or network
    // free text, and the only thing the database needs is which closed fault occurred.
    // No response reached us at all, so there is no provider field to violate a bound.
    // The envelope is structurally valid; only the transport failed.
    return {
      observed: true,
      httpStatus: null,
      providerErrorCode: null,
      providerMessageId: null,
      transportFault: timedOut ? "timeout" : "network",
      envelopeStructurallyValid: true,
    };
  } finally {
    clearTimeout(timer);
  }

  const httpStatus = typeof res.status === "number" ? res.status : null;

  let body: unknown = undefined;
  let bodyReadable = true;
  try {
    body = await res.json();
  } catch {
    bodyReadable = false;
  }
  const record = (body && typeof body === "object") ? body as Record<string, unknown> : null;

  const accepted = httpStatus !== null && httpStatus >= 200 && httpStatus < 300;

  if (accepted && !bodyReadable) {
    // Acceptance is genuinely unknowable: the provider answered 2xx but the acknowledgement
    // could not be read, so the message ID that would confirm it is unavailable.
    // An unreadable acknowledgement is an APPROVED observation shape, not a malformed field:
    // there is no parsed field to violate a bound. Structurally valid.
    return {
      observed: true,
      httpStatus,
      providerErrorCode: null,
      providerMessageId: null,
      transportFault: "unreadable_ack",
      envelopeStructurallyValid: true,
    };
  }

  // A definite response — 2xx with a readable body, or any non-2xx. `message` is never read.
  const errorCode = boundedField(record?.name, PROVIDER_ERROR_CODE_RE);
  const messageId = boundedField(record?.id, PROVIDER_MESSAGE_ID_RE);

  return {
    observed: true,
    httpStatus,
    providerErrorCode: errorCode.value,
    providerMessageId: messageId.value,
    transportFault: "none",
    envelopeStructurallyValid: errorCode.valid && messageId.valid,
  };
}
