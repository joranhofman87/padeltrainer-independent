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
//   * PROVIDER 4xx IS A CONFIG SIGNAL, NOT A ROW VERDICT. Everything row-shaped is validated
//     before the call (E.164 recipient, live consent, committed template, content present), so
//     what remains in the request is environment — the ContentSid, the sender, the account.
//     A 401, or a 400 for an unapproved/wrong-account ContentSid, is a misconfiguration
//     affecting EVERY row; failing rows terminally over it destroys them on the first drain.
//     Those surface as configError so the worker DEFERS them instead of spending the budget.

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
  /**
   * configError marks a failure that is GLOBAL (wrong for every row) rather than a property of
   * this message — missing/invalid credentials, an unusable sender, a 401. The worker must not
   * spend the row's attempt budget on those: a config gap that outlives max_attempts would
   * otherwise permanently fail everything queued behind it.
   */
  | {
      ok: false;
      error: string;
      attempts: number;
      retryable: boolean;
      configError?: true;
      /** Provider says the fault is THIS RECIPIENT's — terminal, never deferred. */
      rowFault?: true;
      /** Twilio's numeric error code, when it gave one. */
      code?: number;
    };

export type TwilioAuth = {
  accountSid: string;
  /** API key SID (SK…) + secret, preferred over the account auth token for outbound calls. */
  apiKeySid?: string;
  apiKeySecret?: string;
  authToken?: string;
};

export const WHATSAPP_MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 400;

/** Transient provider trouble. This is what the row's attempt budget is FOR, so it burns one. */
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * RECIPIENT-specific Twilio codes: the fault is this destination, not our configuration, so
 * these terminal-fail rather than parking for a day waiting on a config fix that isn't coming.
 *
 * Deliberately a CONSERVATIVE allow-list, not an exhaustive table. Unknown 4xx codes keep
 * defaulting to defer, because the two mistakes are not symmetric: a wrongly-deferred row is
 * parked and recoverable, a wrongly-terminal row is a destroyed notification. Codes are added
 * here from evidence — an unrecognised code shows up in the delivery log with its number, which
 * is what promotes it to this list.
 */
const ROW_FAULT_CODES = new Set([
  21211,  // invalid 'To' phone number
  21610,  // recipient has unsubscribed (a STOP we did not otherwise see)
  21614,  // 'To' is not a valid mobile number
]);

/** Twilio's code for "this recipient unsubscribed" — also a consent signal we must record. */
export const TWILIO_CODE_UNSUBSCRIBED = 21610;

/**
 * What the worker should DO with a failed send. Pulled out as a pure function so the policy is
 * unit-testable on its own — the worker's index.ts calls serve() and has no test harness, so
 * leaving this decision inline would leave the actual rules unpinned.
 */
export type WhatsAppFailureAction = "retry" | "defer" | "terminal" | "terminal_optout";

export function whatsappFailureAction(
  outcome: Extract<WhatsAppSendOutcome, { ok: false }>,
): WhatsAppFailureAction {
  // an unsubscribe is consent information, not just a delivery failure
  if (outcome.rowFault && outcome.code === TWILIO_CODE_UNSUBSCRIBED) return "terminal_optout";
  if (outcome.rowFault) return "terminal";
  if (outcome.configError) return "defer";
  return outcome.retryable ? "retry" : "terminal";
}

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
    return { ok: false, error: "missing_account_sid", attempts: 0, retryable: true, configError: true };
  }
  const user = auth.apiKeySid && auth.apiKeySecret ? auth.apiKeySid : auth.accountSid;
  const pass = auth.apiKeySid && auth.apiKeySecret ? auth.apiKeySecret : auth.authToken;
  if (!pass) {
    return { ok: false, error: "missing_twilio_credentials", attempts: 0, retryable: true, configError: true };
  }
  if (!E164.test(payload.to)) {
    // Never guess at a malformed number — a wrong guess messages a stranger.
    return { ok: false, error: "invalid_phone", attempts: 0, retryable: false };
  }
  const sender = normalizeWhatsAppSender(payload.from);
  if (!sender) {
    return { ok: false, error: "invalid_sender", attempts: 0, retryable: true, configError: true };
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

      if (TRANSIENT_STATUS.has(res.status)) {
        if (attempt === maxAttempts) {
          return { ok: false, error: lastError, attempts: attempt, retryable: true };
        }
        // fall through to the backoff and try again in-request
      } else if (typeof bodyJson.code === "number" && ROW_FAULT_CODES.has(bodyJson.code)) {
        // The provider is telling us about THIS RECIPIENT (unsubscribed, unreachable, not a
        // mobile). No amount of config-fixing changes it, so it must not sit in the defer
        // queue for a day pretending to be recoverable.
        return {
          ok: false, error: lastError, attempts: attempt,
          retryable: false, rowFault: true, code: bodyJson.code,
        };
      } else if (res.status >= 400 && res.status < 500) {
        // EVERY OTHER 4xx IS TREATED AS A CONFIG PROBLEM, not a row fault — classified by whose
        // input was wrong rather than by HTTP semantics. By the time we reach Twilio we have
        // already validated everything that belongs to the ROW ourselves (E.164 recipient,
        // live consent, a committed template, content present). What is left in the request is
        // ENVIRONMENT: the ContentSid, the configured sender, the account's own state. Twilio
        // rejecting an unapproved/wrong-account ContentSid or an unusable sender is a statement
        // about our configuration, and terminal-failing queued rows over it would destroy them
        // on the FIRST drain.
        //
        // The asymmetry decides the default: wrongly deferring parks a row visibly, with an
        // ops alert and a bounded lifetime; wrongly terminal-failing silently destroys a real
        // notification. So an ambiguous 4xx defers.
        return {
          ok: false, error: lastError, attempts: attempt, retryable: true, configError: true,
          ...(typeof bodyJson.code === "number" ? { code: bodyJson.code } : {}),
        };
      } else if (attempt === maxAttempts) {
        // unlisted 5xx — treat as transient
        return { ok: false, error: lastError, attempts: attempt, retryable: true };
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
