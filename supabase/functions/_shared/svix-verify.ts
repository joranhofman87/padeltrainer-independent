// Verify a Svix-signed webhook (Resend signs delivery events with Svix).
// Spec: HMAC-SHA256 over `${svix-id}.${svix-timestamp}.${rawBody}` using the
// base64 secret (the part after the `whsec_` prefix), base64-encoded, compared
// (constant-time) against any `v1,<sig>` entry in the space-delimited
// `svix-signature` header. A timestamp tolerance guards against replay.

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

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

export interface SvixVerifyInput {
  secret: string;            // the Svix/Resend signing secret (whsec_…)
  id: string | null;         // svix-id header
  timestamp: string | null;  // svix-timestamp header (unix seconds)
  signature: string | null;  // svix-signature header
  body: string;              // raw request body (verbatim)
  toleranceSeconds?: number; // default 300
  nowMs?: number;            // override for testing
}

export async function verifySvix(input: SvixVerifyInput): Promise<boolean> {
  const { secret, id, timestamp, signature, body } = input;
  if (!secret || !id || !timestamp || !signature) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const tolerance = input.toleranceSeconds ?? 300;
  const nowSec = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSec - ts) > tolerance) return false;

  const rawSecret = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const key = await crypto.subtle.importKey(
    "raw",
    base64ToBytes(rawSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  );
  const expected = bytesToBase64(signed);

  // header: "v1,<sig> v1,<sig2> …"
  for (const part of signature.split(" ")) {
    const [version, sig] = part.split(",");
    if (version === "v1" && sig && timingSafeEqual(sig, expected)) return true;
  }
  return false;
}
