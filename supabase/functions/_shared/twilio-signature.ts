// Verify an X-Twilio-Signature on an inbound Twilio webhook.
//
// Twilio's scheme for form-encoded POSTs: HMAC-SHA1 over the full request URL with every
// POST parameter appended as key+value in KEY-SORTED order, keyed with the account's AUTH
// TOKEN, base64-encoded. (The auth token specifically — an API key/secret pair authenticates
// outbound calls but does NOT sign inbound webhooks.)
//
// This endpoint is reachable by anyone on the internet (verify_jwt = false — Twilio has no
// Supabase JWT), so the signature IS the authentication. Everything here fails closed: a
// missing token, a missing header, or any verification error means "not from Twilio".
//
// The URL must be EXACTLY the one Twilio was configured to call — scheme, host, path and
// query string all feed the HMAC. A proxy that rewrites the host, or a StatusCallback
// configured with a different URL than the one we verify against, silently fails every
// signature. Hence the callback URL is explicit configuration rather than derived.

function bytesToBase64(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

/** The signed string: the URL, then each param as key+value in key-sorted order. */
export function buildTwilioSignatureBase(url: string, params: Record<string, string>): string {
  const keys = Object.keys(params).sort();
  let s = url;
  for (const k of keys) s += k + params[k];
  return s;
}

export interface TwilioVerifyInput {
  authToken: string;                  // TWILIO_AUTH_TOKEN — signs inbound webhooks
  url: string;                        // the exact URL Twilio was configured to call
  params: Record<string, string>;     // the parsed form body
  signature: string | null;           // X-Twilio-Signature header
}

export async function verifyTwilioSignature(input: TwilioVerifyInput): Promise<boolean> {
  const { authToken, url, params, signature } = input;
  if (!authToken || !url || !signature) return false;

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(authToken),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"],
    );
    const signed = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(buildTwilioSignatureBase(url, params)),
    );
    return timingSafeEqual(signature, bytesToBase64(signed));
  } catch {
    return false;   // any crypto/encoding failure = unverified, never "assume ok"
  }
}

/** Twilio's documented opt-out keywords. A STOP is consent withdrawal, not a normal message. */
const OPT_OUT_KEYWORDS = new Set([
  "stop",
  "stopall",
  "unsubscribe",
  "cancel",
  "end",
  "quit",
]);

/** TRUE when an inbound message body is an opt-out keyword (case/whitespace insensitive). */
export function isOptOutKeyword(body: string | null | undefined): boolean {
  if (!body) return false;
  return OPT_OUT_KEYWORDS.has(body.trim().toLowerCase());
}
