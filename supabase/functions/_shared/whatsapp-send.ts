// Bounded Twilio WhatsApp send helper. Mirrors resend-send.ts in shape, with the differences
// WhatsApp actually imposes:
//
//   * NO PROVIDER IDEMPOTENCY. Resend dedupes on an Idempotency-Key for 24h; Twilio's Messages
//     API has no equivalent. Our only protection is the outbox claim (FOR UPDATE SKIP LOCKED
//     under a per-run lock token), so a crash in the window between Twilio accepting the send
//     and record_notification_send_result committing CAN double-send after the 15-minute stale
//     reclaim. Stated plainly rather than papered over: it is bounded by max_attempts, and it
//     is the reason the guards below refuse rather than "try anyway".
//
//   * BUSINESS-INITIATED MESSAGES REQUIRE AN APPROVED TEMPLATE (ContentSid). Free-form Body is
//     only deliverable inside the 24-hour service window, so it is gated behind an explicit
//     opt-in flag and exists for pre-approval testing, not production sends.
//
//   * AUTH FAILURES ARE RETRYABLE HERE. A 401 is a misconfiguration affecting EVERY row, not a
//     property of one message; treating it as terminal would permanently fail the whole queue
//     over a wrong env var. It self-heals once the credentials are corrected.

export type WhatsAppSendPayload = {
  /** "whatsapp:+31…" sender, or a Messaging Service SID (MG…). */
  from: string;
  /** Recipient in bare E.164 — the "whatsapp:" prefix is added here. */
  to: string;
  /** Approved Content template SID (HX…). Preferred; required outside the 24h window. */
  contentSid?: string;
  /** Positional {{n}} → value map for the template. */
  contentVariables?: Record<string, string>;
  /** Free-form body. Only used when no contentSid is supplied AND free-form is allowed. */
  body?: string;
  /** Absolute URL Twilio should POST delivery status to. */
  statusCallback?: string;
};

export type WhatsAppSendOutcome =
  | { ok: true; sid?: string; attempts: number }
  | { ok: false; error: string; attempts: number; retryable: boolean };

export type TwilioAuth = {
  accountSid: string;
  /** API key SID (SK…) + secret, preferred over the account auth token for outbound calls. */
  apiKeySid?: string;
  apiKeySecret?: string;
  authToken?: string;
};

export const WHATSAPP_MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 400;

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
/** Config-level failures: wrong for every row, so retry (they self-heal) rather than burn one. */
const CONFIG_STATUS = new Set([401, 403]);

const E164 = /^\+[1-9][0-9]{7,14}$/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Normalize a configured sender to Twilio's wire form. Accepts a Messaging Service SID as-is. */
export function normalizeWhatsAppSender(raw: string): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  if (v.startsWith("MG")) return v;                       // Messaging Service SID
  if (v.startsWith("whatsapp:")) {
    return E164.test(v.slice("whatsapp:".length)) ? v : null;
  }
  // A bare +316… is unambiguous, so add the prefix Twilio requires rather than failing the
  // whole queue on a missing six characters.
  return E164.test(v) ? `whatsapp:${v}` : null;
}

export async function sendWhatsAppMessage(
  auth: TwilioAuth,
  payload: WhatsAppSendPayload,
  options?: { maxAttempts?: number },
): Promise<WhatsAppSendOutcome> {
  // ---- fail-closed guards. These refuse BEFORE any network call. ----
  if (!auth.accountSid) {
    return { ok: false, error: "missing_account_sid", attempts: 0, retryable: true };
  }
  const user = auth.apiKeySid && auth.apiKeySecret ? auth.apiKeySid : auth.accountSid;
  const pass = auth.apiKeySid && auth.apiKeySecret ? auth.apiKeySecret : auth.authToken;
  if (!pass) {
    return { ok: false, error: "missing_twilio_credentials", attempts: 0, retryable: true };
  }
  if (!E164.test(payload.to)) {
    // Never guess at a malformed number — a wrong guess messages a stranger.
    return { ok: false, error: "invalid_phone", attempts: 0, retryable: false };
  }
  const sender = normalizeWhatsAppSender(payload.from);
  if (!sender) {
    return { ok: false, error: "invalid_sender", attempts: 0, retryable: true };
  }
  if (!payload.contentSid && !payload.body) {
    // No approved template and nothing to say: refuse rather than send an empty message.
    return { ok: false, error: "no_content", attempts: 0, retryable: false };
  }

  const form = new URLSearchParams();
  form.set("To", `whatsapp:${payload.to}`);
  if (sender.startsWith("MG")) form.set("MessagingServiceSid", sender);
  else form.set("From", sender);

  if (payload.contentSid) {
    // Template mode. ContentVariables is a JSON object of positional keys.
    form.set("ContentSid", payload.contentSid);
    form.set("ContentVariables", JSON.stringify(payload.contentVariables ?? {}));
  } else {
    form.set("Body", payload.body!);
  }
  if (payload.statusCallback) form.set("StatusCallback", payload.statusCallback);

  const url = `https://api.twilio.com/2010-04-01/Accounts/${auth.accountSid}/Messages.json`;
  const headers = {
    Authorization: `Basic ${btoa(`${user}:${pass}`)}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };

  const maxAttempts = Math.min(options?.maxAttempts ?? WHATSAPP_MAX_ATTEMPTS, WHATSAPP_MAX_ATTEMPTS);
  let lastError = "Unknown Twilio error";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, { method: "POST", headers, body: form.toString() });
      const parsed = await res.json().catch(() => ({} as Record<string, unknown>));
      const bodyJson = parsed as { sid?: unknown; message?: unknown; code?: unknown };

      if (res.ok) {
        const sid = typeof bodyJson.sid === "string" ? bodyJson.sid : undefined;
        return { ok: true, sid, attempts: attempt };
      }

      const code = typeof bodyJson.code === "number" ? ` (code ${bodyJson.code})` : "";
      lastError = typeof bodyJson.message === "string"
        ? `${bodyJson.message}${code}`
        : `Twilio HTTP ${res.status}${code}`;

      const retryable = RETRYABLE_STATUS.has(res.status) || CONFIG_STATUS.has(res.status);
      // A config failure is not worth burning our in-request retries on — the outbox backoff
      // will re-try it later, by which time the env var may have been fixed.
      if (CONFIG_STATUS.has(res.status)) {
        return { ok: false, error: lastError, attempts: attempt, retryable: true };
      }
      if (!retryable || attempt === maxAttempts) {
        return { ok: false, error: lastError, attempts: attempt, retryable };
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt === maxAttempts) {
        return { ok: false, error: lastError, attempts: attempt, retryable: true };
      }
    }

    await sleep(BASE_DELAY_MS * attempt);
  }

  return { ok: false, error: lastError, attempts: maxAttempts, retryable: true };
}
