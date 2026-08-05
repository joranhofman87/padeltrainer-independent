// N2 — the manage-link token: mint it for a send, verify it on the way back.
//
//     token = v<N> '.' <capability_id> '.' base64url( HMAC-SHA256("notif-manage:v1:v<N>:<id>", key vN) )
//
// WHY THE SIGNATURE AT ALL, when the capability id is already an unguessable uuid. Two reasons,
// and neither is secrecy of the id. First, the id alone would make the manage endpoints an
// ORACLE: anyone could probe ids and learn from the response whether one exists, when it expired,
// which scope it belongs to. With a signature, an unsigned probe is refused before any database
// read. Second, the signing key is the REVOCATION LEVER for a whole generation of links — raising
// `notification_manage_key_state.min_mintable_version` retires every token signed by a burned
// key, which no property of the id could do.
//
// THE KEY LIVES ONLY HERE, in edge env (`NOTIF_MANAGE_TOKEN_KEY_V<n>`). The database stores the
// capability row and its `key_version`, never the HMAC and never the secret — so a database read
// (a backup, a support query, a leaked dump) cannot reconstruct a live link.
//
// WHY THE VERSION IS IN THE TOKEN. It is not secret, and carrying it is what lets the retirement
// floor and the signature be checked BEFORE the capability is looked up — so a burned key or a
// forged token costs no database work, and the "no read for a bad token" property is real rather
// than aspirational. An earlier draft omitted it and asked the caller for the row's version
// first, which inverted that order and made every unauthenticated probe a database query.
//
// THE SIGNED STRING IS DOMAIN-SEPARATED AND BINDS THE VERSION (`notif-manage:v1:v<N>:<id>`), so a
// signature cannot be lifted between key generations, and this HMAC can never be confused with
// another one the platform might sign with a shared secret. `v1` is the FORMAT version — bump it
// only for a wire-format change, which invalidates outstanding links by design.
//
// VERIFICATION IS STILL ROW-BOUND. The signed version says which key must have signed it; the
// caller must then require the capability row's stored `key_version` to EQUAL that version
// (`assertRowKeyVersion` below). Accepting whatever the token claims, without that comparison,
// would let a token signed under one generation act on a row minted under another.
//
// FAILURES ARE TAGGED, AND THE DISTINCTION MATTERS. A caller must answer a forged token and a
// database outage differently: the first is uniform and final (never narrate WHY, that is the
// oracle), the second is RETRYABLE. A one-click unsubscribe answered 200 during an outage is an
// opt-out the sender believes was recorded and will never retry — the action is simply lost. So
// `invalid` and `inactive` map to the uniform public answer, while `db_unavailable` and
// `key_unavailable` must surface as a retryable failure (503 + Retry-After) and an ops alert.

const ENC = new TextEncoder();

/** Domain separation + format version. Bumping `v1` is a deliberate wire break. */
const SIGN_PREFIX = "notif-manage:v1";
/** base64url of a 32-byte HMAC, unpadded. */
const SIG_LEN = 43;
const SIG_RE = /^[A-Za-z0-9_-]{43}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A key must be 32 random bytes, hex-encoded. Anything shorter is offline-guessable from a
 *  single public (message, signature) pair — and every issued link is exactly that pair. */
const KEY_RE = /^[0-9a-fA-F]{64}$/;

function base64url(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Constant-time over EQUAL-LENGTH inputs; the grammar check above makes the length fixed. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export type KeyLookup = (version: number) => string | undefined;

export const envKeyLookup: KeyLookup = (version) =>
  Deno.env.get(`NOTIF_MANAGE_TOKEN_KEY_V${version}`) ?? undefined;

function hexToBytes(hex: string): ArrayBuffer {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  return out.buffer;
}

async function sign(version: number, capabilityId: string, secretHex: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    hexToBytes(secretHex),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const msg = `${SIGN_PREFIX}:v${version}:${capabilityId}`;
  return base64url(await crypto.subtle.sign("HMAC", key, ENC.encode(msg)));
}

/**
 * Build the token for a capability the database just minted.
 *
 * DETERMINISTIC BY CONSTRUCTION: the same version, id and key produce the same bytes, which is
 * what lets a retry of a send rebuild a byte-identical email under an unchanged provider
 * idempotency key. Callers must pass the capability the MINT RPC returned for that send — never a
 * freshly minted one — and the RPC guarantees that by keying on the send.
 *
 * Throws when the named key is absent or malformed: a footer that silently loses its link, or one
 * signed with a guessable secret, is worse than a send that fails loudly and retries once the
 * environment is fixed.
 */
export async function buildManageToken(
  capabilityId: string,
  keyVersion: number,
  lookup: KeyLookup = envKeyLookup,
): Promise<string> {
  if (!UUID_RE.test(capabilityId)) {
    throw new Error("manage-token: capability id is not a uuid");
  }
  if (!Number.isInteger(keyVersion) || keyVersion < 1) {
    throw new Error("manage-token: key version must be a positive integer");
  }
  const secret = lookup(keyVersion);
  if (!secret) {
    throw new Error(`manage-token: no signing key configured for version ${keyVersion}`);
  }
  if (!KEY_RE.test(secret)) {
    throw new Error(
      `manage-token: the key for version ${keyVersion} must be 32 random bytes, hex-encoded (64 hex chars)`,
    );
  }
  return `v${keyVersion}.${capabilityId}.${await sign(keyVersion, capabilityId, secret)}`;
}

/**
 * What verification concluded.
 *
 * `invalid`  — malformed, forged, or a version whose key is not this deployment's business.
 * `inactive` — well-formed and correctly signed, but the key generation is retired.
 * `key_unavailable` / `db_unavailable` — OPERATIONAL. The token may be perfectly good; we cannot
 *              tell. Callers must answer these as retryable (503) rather than acknowledging an
 *              action they did not perform.
 */
export type ManageTokenResult =
  | { ok: true; capabilityId: string; keyVersion: number }
  | { ok: false; reason: "invalid" | "inactive" | "key_unavailable" };

/**
 * Verify a token's GRAMMAR, its retirement status and its SIGNATURE — with no database access.
 *
 * The capability row is not consulted here at all; the caller looks it up afterwards and must
 * then call `assertRowKeyVersion` to bind the signed generation to the stored one.
 */
export async function verifyManageToken(
  token: string | null | undefined,
  minMintableVersion: number,
  lookup: KeyLookup = envKeyLookup,
): Promise<ManageTokenResult> {
  if (!token) return { ok: false, reason: "invalid" };

  // STRICT GRAMMAR, before anything expensive: exactly three parts, a version, a uuid, and a
  // signature of exactly the length a SHA-256 HMAC has in unpadded base64url. Anything else is a
  // probe, and a probe must not reach a key import — let alone a database.
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "invalid" };
  const [vPart, capabilityId, signature] = parts;
  if (!/^v[1-9][0-9]{0,3}$/.test(vPart)) return { ok: false, reason: "invalid" };
  if (!UUID_RE.test(capabilityId)) return { ok: false, reason: "invalid" };
  if (signature.length !== SIG_LEN || !SIG_RE.test(signature)) return { ok: false, reason: "invalid" };

  const version = Number(vPart.slice(1));
  // The retirement floor is checked BEFORE the signature: a burned generation is refused whatever
  // it carries, and the check costs nothing.
  if (version < minMintableVersion) return { ok: false, reason: "inactive" };

  const secret = lookup(version);
  // A version this deployment never had is a forgery attempt; a version it SHOULD have but whose
  // env var is missing is an operational fault. They are indistinguishable from here, so the
  // conservative reading is operational — the caller retries rather than losing a real opt-out.
  if (!secret) return { ok: false, reason: "key_unavailable" };
  if (!KEY_RE.test(secret)) return { ok: false, reason: "key_unavailable" };

  const expected = await sign(version, capabilityId, secret);
  if (!timingSafeEqual(signature, expected)) return { ok: false, reason: "invalid" };
  return { ok: true, capabilityId, keyVersion: version };
}

/**
 * Bind the SIGNED generation to the STORED one.
 *
 * Without this, a token signed under a live key would act on a row minted under a different
 * generation — the per-row binding the key-state table exists for would be decorative. Call it
 * with whatever the capability row says (or null when the row is absent).
 */
export function assertRowKeyVersion(
  result: ManageTokenResult,
  storedKeyVersion: number | null,
): boolean {
  return result.ok && storedKeyVersion !== null && storedKeyVersion === result.keyVersion;
}
