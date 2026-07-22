// Redact obviously-sensitive substrings from a failure DETAIL before it is written to an ops
// surface — a Slack alert or the durable payment_audit_log. This is defence-in-depth, not a
// security boundary: the source strings should not carry secrets, but an error message can
// happen to echo an email, a token, a JWT, a payment/resource id, or a URL query, and those
// must not land in Slack or a long-lived audit row. Whitespace is collapsed and the result is
// length-bounded so it stays a short, safe code/detail.
//
// Order matters: structured tokens (JWT, Bearer, URL query) are redacted before the broad
// "long opaque blob" sweep so their internal segments are not mislabelled.

const JWT = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g;   // header.payload.sig
const BEARER = /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]+/g;
const URL_QUERY = /(https?:\/\/[^\s?#]+)[?#][^\s]*/g;                          // strip query/fragment
// Sensitive TOKENS embedded in URL PATHS — /pay/<token>, /booking/<token>, and the branded
// /academies/<slug>/pay/<token> (covered by the /pay/ arm). Must match SHORT/hyphenated tokens
// too, so this is independent of the generic 32-char rule. Kept in lockstep with the frontend
// policy in src/lib/trackingPrivacy.ts (redactTrackingString) — parity-pinned in the tests so
// the two cannot drift.
const PATH_TOKEN = /(\/(?:pay|booking)\/)[^\s/?#]+/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const RESOURCE_ID = /\b(tr|pl|ord|pay|cst|sub|mdt|rfnd|chr)_[A-Za-z0-9]{6,}/g; // Mollie-style ids
const LONG_TOKEN = /\b[A-Za-z0-9_-]{32,}\b/g;                                  // generic secret-ish blob

export function redactDetail(input: string | null | undefined, max = 200): string {
  let s = String(input ?? "");
  s = s.replace(JWT, "[redacted-jwt]");
  s = s.replace(BEARER, "Bearer [redacted]");
  s = s.replace(URL_QUERY, "$1?[redacted-query]");
  s = s.replace(PATH_TOKEN, "$1[redacted-token]");
  s = s.replace(EMAIL, "[redacted-email]");
  s = s.replace(RESOURCE_ID, "[redacted-id]");
  s = s.replace(LONG_TOKEN, "[redacted-token]");
  s = s.replace(/\s+/g, " ").trim();
  return s.slice(0, max);
}
