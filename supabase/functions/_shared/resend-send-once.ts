/**
 * SINGLE-SHOT Resend send for the ADR-0008 digest worker (10c-a3).
 *
 * Unlike `resend-send.ts` (v1, which retries internally and collapses the outcome to ok/error/retryable),
 * the digest state machine owns retries, backoff, and the breaker — so this adapter makes exactly ONE HTTP
 * attempt and surfaces the FULL outcome the record RPC needs:
 *   record_notification_digest_result(p_transport, p_http_status, p_error_name, p_provider_message_id,
 *                                     ..., p_retry_after_seconds)
 * A hung request is turned into a `timeout` transport outcome (→ the RPC classes it ambiguous → sticky
 * uncertainty, capacity held) rather than blocking. `fetch` is injectable so the logic is unit-testable
 * without network access.
 */

export type ResendSendOncePayload = {
  from: string;
  to: string[];
  subject: string;
  html: string;
};

/** The single-shot outcome, in the exact shape the digest record RPC consumes. */
export type ResendSendOnceResult =
  // A completed HTTP response (any status). error_name/retry_after are set for non-2xx.
  | {
    kind: "response";
    httpStatus: number;
    providerMessageId: string | null;
    errorName: string | null;
    retryAfterSeconds: number | null;
  }
  // No usable outcome — a timeout, a network/transport error, or a 2xx that lacked a provider email id.
  // The record RPC reads `transport`; classify_error maps all of these to `ambiguous` (sticky uncertainty).
  | { kind: "transport"; transport: "timeout" | "network" | "no_response"; message: string };

export const RESEND_ENDPOINT = "https://api.resend.com/emails";
export const DEFAULT_TIMEOUT_MS = 20_000;

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Parse a Retry-After header (delta-seconds, or an HTTP-date) into whole seconds, or null. */
export function parseRetryAfterSeconds(headerValue: string | null, nowMs: number): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (/^\d+$/.test(trimmed)) {
    const secs = Number(trimmed);
    return Number.isFinite(secs) ? secs : null;
  }
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  return Math.max(0, Math.round((when - nowMs) / 1000));
}

/**
 * Send one digest email. Never throws — every failure mode is returned as a result the caller passes
 * straight to record_notification_digest_result.
 *
 * @param opts.idempotencyKey  MUST be the group's provider_idempotency_key (`dg:v1:<group_id>`), so any
 *   re-POST of the same attempt is a no-op at Resend within its dedupe window (no double delivery).
 */
export async function sendResendEmailOnce(
  apiKey: string,
  payload: ResendSendOncePayload,
  opts: {
    idempotencyKey: string;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
    now?: () => number;
  },
): Promise<ResendSendOnceResult> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const now = opts.now ?? (() => Date.now());
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": opts.idempotencyKey,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const body = await res.json().catch(() => ({} as Record<string, unknown>));

    if (res.ok) {
      // A real Resend success ALWAYS carries a non-blank string email id. A 2xx with a missing / blank /
      // non-string id (or an unparseable body) is NOT a usable acceptance — the record RPC would raise on an
      // accepted outcome without a provider id. Report it as a `no_response` transport outcome (→ ambiguous
      // → sticky uncertainty, capacity held), never a false "accepted".
      const rawId = (body as { id?: unknown }).id;
      const id = typeof rawId === "string" && rawId.trim().length > 0 ? rawId : null;
      if (id) {
        return { kind: "response", httpStatus: res.status, providerMessageId: id, errorName: null, retryAfterSeconds: null };
      }
      return { kind: "transport", transport: "no_response", message: `2xx (${res.status}) without a provider email id` };
    }

    // Resend error bodies carry a machine name in `name` (e.g. "validation_error", "rate_limit_exceeded",
    // "daily_quota_exceeded"); fall back to the message. The record RPC's §ERR taxonomy keys on this name.
    const name = typeof (body as { name?: unknown }).name === "string"
      ? (body as { name: string }).name
      : (typeof (body as { message?: unknown }).message === "string" ? (body as { message: string }).message : `http_${res.status}`);
    const retryAfter = parseRetryAfterSeconds(res.headers.get("Retry-After"), now());
    return { kind: "response", httpStatus: res.status, providerMessageId: null, errorName: name, retryAfterSeconds: retryAfter };
  } catch (err) {
    // AbortError (our timeout) → 'timeout' (ambiguous, sticky uncertainty). Anything else → 'network'.
    const isAbort = (err as { name?: string })?.name === "AbortError";
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "transport", transport: isAbort ? "timeout" : "network", message };
  } finally {
    clearTimeout(timer);
  }
}
