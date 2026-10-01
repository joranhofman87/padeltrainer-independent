// U2 — the identity-verification capability token: mint it for a challenge, verify it on return.
//
//     token = v<N> '.' <challenge_id> '.' base64url( HMAC-SHA256("u2-identity-verify:v1:v<N>:<id>", key vN) )
//
// This is a SIBLING of _shared/manage-token.ts, following the identical reviewed pattern — NOT a
// refactor of it. The notification architecture is frozen; a second capability legitimately needs
// its own domain separation ("u2-identity-verify" vs "notif-manage") and its own key
// (IDENTITY_VERIFY_TOKEN_KEY_V<n>), and sharing runtime code would drag frozen reviewed code into
// this diff. The two modules share a shape, not a secret and not a codepath.
//
// WHY A SIGNATURE when the challenge id is already an unguessable uuid. Same two reasons as the
// manage token: (1) the id alone would make the verify endpoint an ORACLE — a probe could learn
// whether a challenge exists, when it expired, whose scope it is; a bad signature is refused before
// any per-challenge database lookup. (2) The signing key is the REVOCATION lever for a whole
// generation of links (identity_verify_key_state.min_mintable_version), which no property of the id
// could provide.
//
// THE KEY LIVES ONLY HERE, in edge env. The database stores the challenge row and its key_version,
// never the HMAC and never the secret — a database read cannot reconstruct a live link.
//
// THE SIGNED STRING binds the version and is domain-separated, so a signature cannot be lifted
// between key generations or confused with any other HMAC the platform signs. VERIFICATION IS
// ROW-BOUND: the caller must require the challenge row's stored key_version to EQUAL the signed
// version (bindIdentityTokenToRow) — accepting whatever the token claims would let a token signed
// under one generation act on a row minted under another.
//
// FAILURES ARE TAGGED. `invalid` (forged/malformed/never-issued) and `inactive` (retired
// generation) both map to the ONE uniform generic response the caller must give — never narrate
// why, that is the oracle. `key_unavailable` is OPERATIONAL and the only retryable one (a key in
// the live window is not configured, or the state row is missing/incoherent): the token may be
// perfectly good and we cannot tell, so the caller answers 503 + Retry-After and alerts rather than
// acknowledging an action it did not perform.

const ENC = new TextEncoder();

/** Domain separation + format version. Bumping `v1` is a deliberate wire break. */
const SIGN_PREFIX = "u2-identity-verify:v1";
/** PostgreSQL int is the column type behind key_version, so its max is the only honest bound. */
const MAX_KEY_VERSION = 2147483647;
/** base64url of a 32-byte HMAC, unpadded. */
const SIG_LEN = 43;
const SIG_RE = /^[A-Za-z0-9_-]{43}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 32 random bytes, hex-encoded. Anything shorter is offline-guessable from one public
 *  (message, signature) pair — and every issued link is exactly that pair. */
const KEY_RE = /^[0-9a-fA-F]{64}$/;

function base64url(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Constant-time over EQUAL-LENGTH inputs; the grammar check makes the length fixed. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export type KeyLookup = (version: number) => string | undefined;

export const envKeyLookup: KeyLookup = (version) =>
  Deno.env.get(`IDENTITY_VERIFY_TOKEN_KEY_V${version}`) ?? undefined;

function hexToBytes(hex: string): ArrayBuffer {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  return out.buffer;
}

async function sign(version: number, challengeId: string, secretHex: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    hexToBytes(secretHex),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const msg = `${SIGN_PREFIX}:v${version}:${challengeId}`;
  return base64url(await crypto.subtle.sign("HMAC", key, ENC.encode(msg)));
}

/** The authoritative signing-key state, read from identity_verify_key_state. A MISSING row must
 *  reach this as null (operational), never a defaulted generation 1. */
export interface IdentityKeyState {
  currentVersion: number;
  minMintableVersion: number;
}

function validState(s: IdentityKeyState | null): s is IdentityKeyState {
  return !!s
    && Number.isInteger(s.currentVersion) && Number.isInteger(s.minMintableVersion)
    && s.minMintableVersion >= 1 && s.currentVersion >= s.minMintableVersion
    && s.currentVersion <= MAX_KEY_VERSION;
}

/**
 * Build the token for a challenge the database just minted. Deterministic by construction (same
 * version + id + key → same bytes), so a retried enqueue rebuilds a byte-identical link under an
 * unchanged provider idempotency key. Throws on every refusal — a missing/weak key, a retired or
 * above-current generation, a bad id: a link that cannot work is worse than a loud failure.
 */
export async function buildIdentityToken(
  challengeId: string,
  keyVersion: number,
  state: IdentityKeyState | null,
  lookup: KeyLookup = envKeyLookup,
): Promise<string> {
  if (!UUID_RE.test(challengeId)) {
    throw new Error("identity-token: challenge id is not a uuid");
  }
  if (!Number.isInteger(keyVersion) || keyVersion < 1 || keyVersion > MAX_KEY_VERSION) {
    throw new Error("identity-token: key version must be a positive int (1..2147483647)");
  }
  if (!validState(state)) {
    throw new Error("identity-token: signing-key state is missing or incoherent");
  }
  if (keyVersion < state.minMintableVersion) {
    throw new Error(
      `identity-token: generation ${keyVersion} is RETIRED (floor ${state.minMintableVersion})`,
    );
  }
  if (keyVersion > state.currentVersion) {
    throw new Error(
      `identity-token: generation ${keyVersion} is above the current generation ${state.currentVersion}`,
    );
  }
  const secret = lookup(keyVersion);
  if (!secret) {
    throw new Error(`identity-token: no signing key configured for version ${keyVersion}`);
  }
  if (!KEY_RE.test(secret)) {
    throw new Error(
      `identity-token: the key for version ${keyVersion} must be 32 random bytes, hex-encoded (64 hex chars)`,
    );
  }
  return `v${keyVersion}.${challengeId}.${await sign(keyVersion, challengeId, secret)}`;
}

export type IdentityTokenResult =
  | { ok: true; challengeId: string; keyVersion: number }
  | { ok: false; reason: "invalid" | "inactive" | "key_unavailable" };

/**
 * Verify a token's GRAMMAR, retirement status and SIGNATURE — with no database access. The
 * challenge row is not consulted here; the caller looks it up afterwards and must then call
 * bindIdentityTokenToRow to bind the signed generation to the stored one.
 */
export async function verifyIdentityToken(
  token: string | null | undefined,
  state: IdentityKeyState | null,
  lookup: KeyLookup = envKeyLookup,
): Promise<IdentityTokenResult> {
  if (!validState(state)) return { ok: false, reason: "key_unavailable" };
  if (!token) return { ok: false, reason: "invalid" };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "invalid" };
  const [vPart, challengeId, signature] = parts;
  if (!/^v[1-9][0-9]{0,9}$/.test(vPart)) return { ok: false, reason: "invalid" };
  if (!UUID_RE.test(challengeId)) return { ok: false, reason: "invalid" };
  if (signature.length !== SIG_LEN || !SIG_RE.test(signature)) return { ok: false, reason: "invalid" };

  const version = Number(vPart.slice(1));
  // ABOVE current = never issued by this deployment = forgery (and cheap to refuse before a key
  // load, so an attacker-chosen version cannot manufacture 503s/ops alerts).
  if (version > state.currentVersion) return { ok: false, reason: "invalid" };
  // BELOW the floor = burned generation, refused whatever it carries.
  if (version < state.minMintableVersion) return { ok: false, reason: "inactive" };

  const secret = lookup(version);
  if (!secret) return { ok: false, reason: "key_unavailable" };
  if (!KEY_RE.test(secret)) return { ok: false, reason: "key_unavailable" };

  const expected = await sign(version, challengeId, secret);
  if (!timingSafeEqual(signature, expected)) return { ok: false, reason: "invalid" };
  return { ok: true, challengeId, keyVersion: version };
}

/** What the caller's challenge-row lookup found. TAGGED, not `number | null`: a Supabase read that
 *  fails yields data:null, and treating that as "no such row" would answer a good token with the
 *  uniform rejection. */
export type IdentityRowLookup =
  | { found: true; keyVersion: number }
  | { found: false }
  | { unavailable: true };

/**
 * Bind the SIGNED generation to the STORED one. Without this a token signed under a live key could
 * act on a row minted under a different generation — the per-row binding the key-state table exists
 * for would be decorative. Returns a RESULT (not a boolean) so a security condition cannot be
 * called and ignored; the caller must pass THIS return value onward, never the pre-binding input.
 */
export function bindIdentityTokenToRow(
  result: IdentityTokenResult,
  row: IdentityRowLookup,
): IdentityTokenResult {
  if (!result.ok) return result;
  if ("unavailable" in row) return { ok: false, reason: "key_unavailable" };  // retryable
  if (!row.found) return { ok: false, reason: "invalid" };
  if (row.keyVersion !== result.keyVersion) return { ok: false, reason: "invalid" };
  return result;
}
