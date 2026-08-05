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
// floor and the signature be checked BEFORE THE CAPABILITY ROW IS LOOKED UP — so a burned key or
// a forged token never costs a capability read. (Stated precisely: the caller does read the
// authoritative key-state row first; that is one cheap, cacheable, recipient-independent read.
// What an unauthenticated probe cannot cause is a per-token capability lookup.) An earlier draft
// omitted the version and asked the caller for the row's version first, which inverted that order
// and made every probe a capability query.
//
// THE SIGNED STRING IS DOMAIN-SEPARATED AND BINDS THE VERSION (`notif-manage:v1:v<N>:<id>`), so a
// signature cannot be lifted between key generations, and this HMAC can never be confused with
// another one the platform might sign with a shared secret. `v1` is the FORMAT version — bump it
// only for a wire-format change, which invalidates outstanding links by design.
//
// VERIFICATION IS STILL ROW-BOUND. The signed version says which key must have signed it; the
// caller must then require the capability row's stored `key_version` to EQUAL that version
// (`bindManageTokenToRow` below). Accepting whatever the token claims, without that comparison,
// would let a token signed under one generation act on a row minted under another.
//
// FAILURES ARE TAGGED, AND THE DISTINCTION MATTERS. A caller must answer a forged token and an
// operational fault differently: the first is uniform and final (never narrate WHY, that is the
// oracle), the second is RETRYABLE. A one-click unsubscribe answered 200 during a key rollout is
// an opt-out the sender believes was recorded and will never retry — the action is simply lost.
// So `invalid` and `inactive` map to the uniform public answer, while `key_unavailable` must
// surface as a retryable failure (503 + Retry-After) plus an ops alert. The caller's OWN database
// failures are its own to classify the same way; this module never touches the database.
//
// ...WHICH IS WHY VERIFICATION TAKES THE WHOLE KEY STATE, not just the floor. A version ABOVE the
// current generation was never issued by this deployment, so it is a forgery — but if the only
// question asked were "is the key loaded?", `v9999.<uuid>.<43 valid chars>` would answer
// `key_unavailable`, and an unauthenticated stranger could mint 503s and ops alerts at will. The
// bounded window [min, current] is what separates "we should have this key and do not" (real, and
// worth waking someone) from "no such generation ever existed" (a probe).

const ENC = new TextEncoder();

/** Domain separation + format version. Bumping `v1` is a deliberate wire break. */
const SIGN_PREFIX = "notif-manage:v1";
/** One ceiling, shared by mint, the grammar and the state validation. PostgreSQL `int` is the
 *  column type behind key_version, so its max is the only honest bound — a helper-only ceiling
 *  would make a legal database value unmintable or unverifiable. */
const MAX_KEY_VERSION = 2147483647;
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
  if (!Number.isInteger(keyVersion) || keyVersion < 1 || keyVersion > MAX_KEY_VERSION) {
    throw new Error("manage-token: key version must be a positive int (1..2147483647)");
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
 * `invalid`  — malformed, forged, a generation never issued, or a signature that does not verify.
 * `inactive` — a RETIRED generation. Decided from the version alone, before the signature: a
 *              burned key is refused whatever the token carries.
 * `key_unavailable` — OPERATIONAL, and the only retryable one: the key state is missing or
 *              incoherent, or a key inside the live window [min, current] is not configured. The
 *              token may be perfectly good and we cannot tell. Callers must answer 503 +
 *              Retry-After and alert, never acknowledge an action they did not perform. (A
 *              caller's own database failure belongs in this class too, decided by the caller.)
 */
export type ManageTokenResult =
  | { ok: true; capabilityId: string; keyVersion: number }
  | { ok: false; reason: "invalid" | "inactive" | "key_unavailable" };

/**
 * The authoritative signing-key state, read from `notification_manage_key_state`.
 *
 * Both bounds are needed and both are validated: an unvalidated floor (NaN from a bad parse, or a
 * mistakenly defaulted 0) makes the retirement comparison fail OPEN, and without the ceiling a
 * never-issued version reads as an operational fault. A MISSING state row must reach this as
 * `null`, which is operational — the S1 contract is that absence retires everything rather than
 * defaulting to generation 1.
 */
export interface ManageKeyState {
  currentVersion: number;
  minMintableVersion: number;
}

function validState(s: ManageKeyState | null): s is ManageKeyState {
  return !!s
    && Number.isInteger(s.currentVersion) && Number.isInteger(s.minMintableVersion)
    && s.minMintableVersion >= 1 && s.currentVersion >= s.minMintableVersion
    && s.currentVersion <= MAX_KEY_VERSION;
}

/**
 * Verify a token's GRAMMAR, its retirement status and its SIGNATURE — with no database access.
 *
 * The capability row is not consulted here at all; the caller looks it up afterwards and must
 * then call `assertRowKeyVersion` to bind the signed generation to the stored one.
 */
export async function verifyManageToken(
  token: string | null | undefined,
  state: ManageKeyState | null,
  lookup: KeyLookup = envKeyLookup,
): Promise<ManageTokenResult> {
  // A missing or incoherent state is OPERATIONAL: we cannot tell a live token from a retired one,
  // and answering "invalid" would quietly discard real opt-outs.
  if (!validState(state)) return { ok: false, reason: "key_unavailable" };
  if (!token) return { ok: false, reason: "invalid" };

  // STRICT GRAMMAR, before anything expensive: exactly three parts, a version, a uuid, and a
  // signature of exactly the length a SHA-256 HMAC has in unpadded base64url. Anything else is a
  // probe, and a probe must not reach a key import — let alone a database.
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "invalid" };
  const [vPart, capabilityId, signature] = parts;
  if (!/^v[1-9][0-9]{0,9}$/.test(vPart)) return { ok: false, reason: "invalid" };
  if (!UUID_RE.test(capabilityId)) return { ok: false, reason: "invalid" };
  if (signature.length !== SIG_LEN || !SIG_RE.test(signature)) return { ok: false, reason: "invalid" };

  const version = Number(vPart.slice(1));
  // ABOVE the current generation = never issued by this deployment = a forgery, and cheap to
  // refuse. Without this arm an attacker-chosen version would fall through to "the key is not
  // loaded" and manufacture 503s and ops alerts from unauthenticated traffic.
  if (version > state.currentVersion) return { ok: false, reason: "invalid" };
  // BELOW the floor = a burned generation, refused whatever it carries, before any key load.
  if (version < state.minMintableVersion) return { ok: false, reason: "inactive" };

  // Inside [min, current] the key SHOULD be configured. Its absence is therefore a real
  // operational fault — the one case where the caller must retry rather than acknowledge.
  const secret = lookup(version);
  if (!secret) return { ok: false, reason: "key_unavailable" };
  if (!KEY_RE.test(secret)) return { ok: false, reason: "key_unavailable" };

  const expected = await sign(version, capabilityId, secret);
  if (!timingSafeEqual(signature, expected)) return { ok: false, reason: "invalid" };
  return { ok: true, capabilityId, keyVersion: version };
}

/**
 * What the caller's capability-row lookup found. TAGGED, not `number | null`, because those two
 * outcomes must never be conflated: a Supabase read that fails commonly yields `data: null`, and
 * treating that as "no such row" would answer a legitimate one-click unsubscribe with the uniform
 * public rejection — which S5 maps to 200 — losing the opt-out exactly as before.
 */
export type ManageRowLookup =
  | { found: true; keyVersion: number }
  | { found: false }
  | { unavailable: true };

/**
 * Bind the SIGNED generation to the STORED one.
 *
 * Without this step a token signed under a live key could act on a row minted under a different
 * generation — the per-row binding the key-state table exists for would be decorative.
 *
 * It returns a RESULT rather than a boolean because a boolean can be called and ignored while the
 * caller believes a security condition was enforced. That is necessary but not sufficient: the
 * pre-binding result still carries a `capabilityId`, so S5's adapter must be the ONLY path that
 * reaches context/apply, and it must pass THIS return value on — never the input.
 */
export function bindManageTokenToRow(
  result: ManageTokenResult,
  row: ManageRowLookup,
): ManageTokenResult {
  if (!result.ok) return result;
  if ("unavailable" in row) return { ok: false, reason: "key_unavailable" };  // retryable
  if (!row.found) return { ok: false, reason: "invalid" };
  if (row.keyVersion !== result.keyVersion) return { ok: false, reason: "invalid" };
  return result;
}
