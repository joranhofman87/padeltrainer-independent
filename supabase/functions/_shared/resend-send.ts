/**
 * Bounded Resend send helper for edge functions.
 * Retries transient failures without blocking critical paths for long.
 */

export type ResendSendPayload = {
  from: string;
  to: string[];
  subject: string;
  html: string;
  attachments?: Array<{ filename: string; content: string | Uint8Array }>;
};

export type ResendSendOutcome =
  | { ok: true; id?: string; attempts: number }
  | { ok: false; error: string; attempts: number; retryable: boolean };

/** Max attempts including the first try. Total backoff stays under ~3s. */
export const RESEND_MAX_ATTEMPTS = 3;
const RESEND_BASE_DELAY_MS = 400;

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send via Resend REST API with bounded retries.
 * Email failure returns `{ ok: false }` — callers must not throw unless the
 * whole operation should abort.
 */
export async function sendResendEmail(
  apiKey: string,
  payload: ResendSendPayload,
  options?: { maxAttempts?: number },
): Promise<ResendSendOutcome> {
  const maxAttempts = Math.min(options?.maxAttempts ?? RESEND_MAX_ATTEMPTS, RESEND_MAX_ATTEMPTS);
  let lastError = "Unknown Resend error";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const body = await res.json().catch(() => ({}));

      if (res.ok) {
        const id = typeof body?.id === "string" ? body.id : undefined;
        return { ok: true, id, attempts: attempt };
      }

      lastError = typeof body?.message === "string"
        ? body.message
        : `Resend HTTP ${res.status}`;

      const retryable = isRetryableStatus(res.status);
      if (!retryable || attempt === maxAttempts) {
        return { ok: false, error: lastError, attempts: attempt, retryable };
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt === maxAttempts) {
        return { ok: false, error: lastError, attempts: attempt, retryable: true };
      }
    }

    await sleep(RESEND_BASE_DELAY_MS * attempt);
  }

  return { ok: false, error: lastError, attempts: maxAttempts, retryable: true };
}
