/**
 * SLICE A part 2 — the decision the identity sender makes about ONE claimed row, as a pure
 * function.
 *
 * It lives here rather than inside the worker loop for the same reason `instant-send-gate.ts` does:
 * the ordering of these checks IS the security property, and a property that can only be exercised
 * by standing up a worker, a database and a mail provider is a property nobody re-tests after the
 * third refactor. Everything below is decided from values; the caller performs the verdict.
 *
 * THE ORDER IS THE CONTRACT, and each step is here because skipping it does real damage:
 *
 *   1. a row we cannot resolve to a challenge   -> terminal. There is nothing to send, ever.
 *   2. an already-consumed challenge            -> terminal, and NOT an error. The visitor already
 *                                                  chose; mailing a capability for a decision that
 *                                                  is already made is a live link nobody needs.
 *   3. an expired challenge                     -> terminal. The link would be dead on arrival, and
 *                                                  a dead link reads to a customer as a broken
 *                                                  product rather than an expiry.
 *   4. a retired signing generation             -> terminal. `buildIdentityToken` would throw; this
 *                                                  turns it into a diagnosable code instead of a
 *                                                  stack trace at send time.
 *   5. a structurally undeliverable address     -> terminal, with the STABLE code the product shows
 *                                                  the visitor. Never a silent fallback to "create a
 *                                                  new Player": that is how a returning customer
 *                                                  silently becomes a duplicate.
 *   6. otherwise                                -> send.
 *
 * Marketing consent is deliberately absent from this list. A verification challenge is a required
 * transactional/security message (`notification_event_types.required_delivery = true`, footer policy
 * `none`), and letting a marketing preference suppress it would lock a returning visitor out of
 * their own identity. Suppression here is only ever about DELIVERABILITY.
 */

/** Stable, visible, non-PII. These strings are a product surface: they appear in telemetry and are
 *  what support will quote back. Renaming one is a breaking change, not a tidy-up. */
export type IdentitySendRefusal =
  | "identity_send_no_challenge"
  | "identity_send_already_consumed"
  | "identity_send_expired"
  | "identity_send_key_retired"
  | "identity_send_undeliverable";

export interface IdentitySendTarget {
  contact_normalized: string | null;
  workflow: string | null;
  key_version: number | null;
  expires_at: string | null;
  already_consumed: boolean | null;
  key_mintable: boolean | null;
}

export type IdentitySendVerdict =
  | { action: "send"; to: string; workflow: string; keyVersion: number }
  | { action: "stop"; code: IdentitySendRefusal; terminal: true };

export interface IdentitySendInputs {
  target: IdentitySendTarget | null;
  /** now, injected so expiry is testable without sleeping. */
  now: Date;
  /** Deliverability only — never a marketing preference. Fail CLOSED: an unreadable suppression
   *  state is treated as undeliverable, because sending to a hard-bounced address damages the
   *  sending domain for every other customer. */
  suppressed: boolean | null;
}

export function evaluateIdentitySendGate(i: IdentitySendInputs): IdentitySendVerdict {
  const t = i.target;
  if (!t || !t.contact_normalized || !t.key_version || !t.expires_at) {
    return { action: "stop", code: "identity_send_no_challenge", terminal: true };
  }
  if (t.already_consumed === true) {
    return { action: "stop", code: "identity_send_already_consumed", terminal: true };
  }
  const expires = Date.parse(t.expires_at);
  if (!Number.isFinite(expires) || expires <= i.now.getTime()) {
    return { action: "stop", code: "identity_send_expired", terminal: true };
  }
  // `key_mintable` is the database's answer to "is this generation still at or above the floor".
  // NULL means we could not establish it, which is not the same as yes.
  if (t.key_mintable !== true) {
    return { action: "stop", code: "identity_send_key_retired", terminal: true };
  }
  if (i.suppressed !== false) {
    return { action: "stop", code: "identity_send_undeliverable", terminal: true };
  }
  return {
    action: "send",
    to: t.contact_normalized,
    workflow: t.workflow ?? "slot",
    keyVersion: t.key_version,
  };
}

/**
 * The message, in the visitor's language. Two languages because the product ships two; the copy is
 * deliberately thin — a challenge email that explains too much becomes a phishing template.
 *
 * It names no candidate, no academy and no Player: the whole point of the flow is that nothing about
 * who might match is disclosed until control of the address is proven. It also states plainly that
 * an unexpected mail can be ignored, which is what makes an accidental send harmless.
 */
export function renderIdentityVerificationEmail(
  lang: "nl" | "en",
  link: string,
): { subject: string; html: string } {
  if (lang === "nl") {
    return {
      subject: "Bevestig dat jij dit bent",
      html: [
        "<p>Hallo,</p>",
        "<p>Je hebt zojuist een reservering of aanmelding gestart. Om verder te gaan, bevestigen we",
        " even dat dit e-mailadres van jou is.</p>",
        `<p><a href="${link}">Bevestig dit e-mailadres</a></p>`,
        "<p>Deze link is kort geldig en werkt één keer.</p>",
        "<p>Heb je dit niet aangevraagd? Dan hoef je niets te doen — zonder bevestiging gebeurt er niets.</p>",
      ].join(""),
    };
  }
  return {
    subject: "Confirm this is you",
    html: [
      "<p>Hello,</p>",
      "<p>You just started a booking or sign-up. To continue, we need to confirm that this email",
      " address is yours.</p>",
      `<p><a href="${link}">Confirm this email address</a></p>`,
      "<p>This link is valid briefly and works once.</p>",
      "<p>Didn't request this? You can ignore this message — nothing happens without confirmation.</p>",
    ].join(""),
  };
}

/**
 * The link. `/verify-identity` is the deployed landing route, and the token travels in the fragment-
 * free query string because the page strips it from the URL on load.
 *
 * The token is built by the caller from `buildIdentityToken` at SEND time and is never persisted:
 * not in the outbox payload, not in a log line, not in provider metadata. This function exists so
 * that the one place a token is allowed to appear — inside the mail body — is a single, reviewable
 * expression.
 */
export function identityVerificationLink(baseUrl: string, token: string): string {
  const root = baseUrl.replace(/\/+$/, "");
  return `${root}/verify-identity?t=${encodeURIComponent(token)}`;
}
