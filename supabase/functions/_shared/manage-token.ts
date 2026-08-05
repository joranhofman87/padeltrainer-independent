// N2 — the manage-link token: mint it for a send, verify it on the way back.
//
//     token = <capability_id> '.' base64url( HMAC-SHA256(capability_id, key vN) )
//
// WHY THE SIGNATURE AT ALL, when the capability id is already an unguessable uuid. Two reasons,
// and neither is secrecy of the id. First, the id alone would make the manage endpoints an
// ORACLE: anyone could probe ids and learn from the response whether one exists, when it expired,
// which scope it belongs to. With a signature, an unsigned probe never reaches the database at
// all. Second, the signing key is the REVOCATION LEVER for a whole generation of links — raising
// `notification_manage_key_state.min_mintable_version` retires every token signed by a burned
// key, which no property of the id could do.
//
// THE KEY LIVES ONLY HERE, in edge env (`NOTIF_MANAGE_TOKEN_KEY_V<n>`). The database stores the
// capability row and its `key_version`, never the HMAC and never the secret — so a database read
// (a backup, a support query, a leaked dump) cannot reconstruct a live link.
//
// VERSION SELECTION IS NOT A TRIAL-AND-ACCEPT. The token carries no version, so verification
// looks up the capability's STORED key_version and checks the signature against THAT key only.
// Trying every loaded key and accepting the first match would silently undo the per-row binding:
// a token signed by a retired key would keep working for as long as that key stayed in the
// environment. Here a retired key fails because the row says which key must have signed it, and
// the caller is told to refuse. (This is docs/NOTIFICATION_FOLLOWUPS.md §N2 item 5.)
//
// EVERY FAILURE IS THE SAME FAILURE to the caller: `null`. Malformed, unknown version, bad
// signature — the endpoint must not narrate which, because the difference is exactly what a prober
// would be mapping.

const ENC = new TextEncoder();

/** base64url without padding — safe in a URL path or query, unlike plain base64. */
function base64url(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Length-invariant compare. A `===` on the signature leaks its prefix through timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

/**
 * The signing key for one version, read from the environment.
 *
 * Versions are explicit rather than "the newest one we have": a capability names the version that
 * signed it, and that name has to resolve to the same bytes years later or its link dies early.
 */
export type KeyLookup = (version: number) => string | undefined;

export const envKeyLookup: KeyLookup = (version) =>
  Deno.env.get(`NOTIF_MANAGE_TOKEN_KEY_V${version}`) ?? undefined;

async function sign(capabilityId: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    ENC.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64url(await crypto.subtle.sign("HMAC", key, ENC.encode(capabilityId)));
}

/**
 * Build the token for a capability the database just minted.
 *
 * DETERMINISTIC BY CONSTRUCTION: the same capability id and the same key produce the same bytes,
 * which is what lets a retry of a send rebuild a byte-identical email under an unchanged provider
 * idempotency key. Callers must therefore pass the capability the MINT RPC returned for that
 * send — never a freshly minted one — and the RPC guarantees that by keying on the send.
 *
 * Throws when the named key is absent: a footer that silently loses its link is worse than a send
 * that fails loudly and retries once the environment is fixed.
 */
export async function buildManageToken(
  capabilityId: string,
  keyVersion: number,
  lookup: KeyLookup = envKeyLookup,
): Promise<string> {
  const secret = lookup(keyVersion);
  if (!secret) {
    throw new Error(`manage-token: no signing key configured for version ${keyVersion}`);
  }
  return `${capabilityId}.${await sign(capabilityId, secret)}`;
}

/**
 * Verify a token and return the capability id it names, or null.
 *
 * `minMintableVersion` comes from `notification_manage_key_state` and is the retirement floor: a
 * token signed by a retired key is refused HERE, before any database read, so a burned key stops
 * working the moment the floor is raised — not whenever the key is finally removed from the
 * environment. The database enforces the same floor again in `apply`/`get_context`, because two
 * layers that each fail closed is the point.
 *
 * The capability id is validated as a uuid before use: it is interpolated into an RPC argument,
 * and shape-checking it here keeps a malformed token from becoming a database error message.
 */
export async function verifyManageToken(
  token: string | null | undefined,
  storedKeyVersionFor: (capabilityId: string) => Promise<number | null>,
  minMintableVersion: number,
  lookup: KeyLookup = envKeyLookup,
): Promise<string | null> {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;

  const capabilityId = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(capabilityId)) {
    return null;
  }

  try {
    // The ROW says which key must have signed this token. Anything else — including a key that is
    // still loaded — is not a match.
    const version = await storedKeyVersionFor(capabilityId);
    if (version === null || version < minMintableVersion) return null;

    const secret = lookup(version);
    if (!secret) return null;

    const expected = await sign(capabilityId, secret);
    return timingSafeEqual(signature, expected) ? capabilityId : null;
  } catch {
    // A lookup failure is indistinguishable from a bad token to the caller, on purpose: an
    // endpoint that answered differently when the database was unreachable would leak that too.
    return null;
  }
}
