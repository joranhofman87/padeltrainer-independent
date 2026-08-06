import { assertEquals, assertRejects } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import {
  bindManageTokenToRow,
  buildManageToken,
  verifyManageToken,
  type KeyLookup,
  type ManageKeyState,
} from "./manage-token.ts";

// N2 — the manage-link token. What these pin, worst-consequence first:
//   * an OPERATIONAL failure (missing key) is tagged separately from a forged token, because a
//     one-click unsubscribe answered 200 during an outage is an opt-out that is simply lost;
//   * the retirement floor and the signature are checked before any CAPABILITY-ROW lookup (the
//     caller does read the cheap, recipient-independent key-state row first), so a probe cannot
//     cause a capability-specific lookup and the endpoints are not an existence/expiry/scope
//     oracle;
//   * the signed generation must equal the row's stored generation, or per-row key binding is
//     decorative;
//   * the wire format is frozen by an externally computed KNOWN-ANSWER vector — round-tripping
//     through this same implementation would let a serialization change invalidate 13–26 months
//     of issued links with every test still green;
//   * a weak or wrongly-encoded signing key is refused, since every issued link is a public
//     (message, signature) pair to guess against.

const CAP = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
// 32 random bytes, hex — the documented key encoding.
const K1 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const K2 = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const keys: Record<number, string> = { 1: K1, 2: K2 };
const lookup: KeyLookup = (v) => keys[v];
/** the authoritative state a caller reads from notification_manage_key_state */
const st = (currentVersion: number, minMintableVersion: number): ManageKeyState =>
  ({ currentVersion, minMintableVersion });
const LIVE = st(2, 1);

/**
 * KNOWN-ANSWER VECTOR, computed OUTSIDE this module (node crypto, independently):
 *   HMAC-SHA256(key = hex-decoded K1, msg = "notif-manage:v1:v1:<CAP>") → base64url, unpadded.
 * If a change to the message shape, the encoding, or the key handling makes this fail, that
 * change has invalidated every link already in somebody's inbox.
 */
const VECTOR = "GzsU-G69nu9BJ3Vj-GODL1kXcHgbru48JpKRWB9-ijg";

Deno.test("KNOWN ANSWER: the wire format is frozen (mint) and accepted (verify)", async () => {
  const token = await buildManageToken(CAP, 1, LIVE, lookup);
  assertEquals(token, `v1.${CAP}.${VECTOR}`);
  const r = await verifyManageToken(token, LIVE, lookup);
  assertEquals(r, { ok: true, capabilityId: CAP, keyVersion: 1 });
});

Deno.test("minting is deterministic — a retry rebuilds the same bytes", async () => {
  assertEquals(await buildManageToken(CAP, 1, LIVE, lookup), await buildManageToken(CAP, 1, LIVE, lookup));
});

Deno.test("the MESSAGE binds the generation — proven with the SAME key for both", async () => {
  // Using different keys would pass even if vN were dropped from the signed message: the key
  // change alone would move the signature. One key, two generations, isolates the message.
  const oneKey: KeyLookup = () => K1;
  const v1 = await buildManageToken(CAP, 1, LIVE, oneKey);
  const v2 = await buildManageToken(CAP, 2, LIVE, oneKey);
  assertEquals(v1.split(".")[2] === v2.split(".")[2], false);
  // ...and the capability id is bound too
  assertEquals((await buildManageToken(OTHER, 1, LIVE, oneKey)).split(".")[2] === v1.split(".")[2], false);
});

Deno.test("a signature lifted onto another generation's header is refused", async () => {
  // domain separation: the v1 signature does not verify as a v2 token
  const v1 = await buildManageToken(CAP, 1, LIVE, lookup);
  const forged = `v2.${CAP}.${v1.split(".")[2]}`;
  assertEquals(await verifyManageToken(forged, LIVE, lookup), { ok: false, reason: "invalid" });
});

Deno.test("a RETIRED generation is 'inactive', decided before the key is even loaded", async () => {
  const token = await buildManageToken(CAP, 1, LIVE, lookup);
  let loads = 0;
  const counting: KeyLookup = (v) => { loads++; return keys[v]; };
  assertEquals(await verifyManageToken(token, st(2, 2), counting), { ok: false, reason: "inactive" });
  assertEquals(loads, 0);
});

Deno.test("a MISSING key is OPERATIONAL, not 'invalid' — the caller must retry, not acknowledge", async () => {
  // minted while v3 was configured; verified after that env var went missing
  // v3 is INSIDE the live window, so its key SHOULD be configured — its absence is a real fault
  const token = await buildManageToken(CAP, 3, st(3, 1), (v) => (v === 3 ? K1 : undefined));
  assertEquals(await verifyManageToken(token, st(3, 1), lookup), { ok: false, reason: "key_unavailable" });
});

Deno.test("a malformed key is also OPERATIONAL rather than a silent weak-key acceptance", async () => {
  const weak: KeyLookup = () => "short";
  const token = await buildManageToken(CAP, 1, LIVE, lookup);
  assertEquals(await verifyManageToken(token, LIVE, weak), { ok: false, reason: "key_unavailable" });
});

Deno.test("STRICT GRAMMAR: nothing malformed reaches a key load", async () => {
  let loads = 0;
  const counting: KeyLookup = (v) => { loads++; return keys[v]; };
  const good = await buildManageToken(CAP, 1, LIVE, lookup);
  const sig = good.split(".")[2];
  const bad = [
    null, undefined, "", ".", "..", `v1.${CAP}`, `${CAP}.${sig}`,          // shape
    `v1.${CAP}.${sig}.extra`,                                              // extra separator
    `v0.${CAP}.${sig}`, `vx.${CAP}.${sig}`, `v.${CAP}.${sig}`,             // version grammar
    `v1.not-a-uuid.${sig}`, `v1.${CAP}x.${sig}`,                           // id grammar
    `v1.${CAP}.${sig.slice(0, -1)}`,                                       // truncated signature
    `v1.${CAP}.${sig}A`,                                                   // oversized signature
    `v1.${CAP}.${"!".repeat(43)}`,                                         // invalid alphabet
  ];
  for (const t of bad) {
    assertEquals(await verifyManageToken(t as string | null, LIVE, counting), { ok: false, reason: "invalid" }, `${t}`);
  }
  assertEquals(loads, 0);
});

Deno.test("a tampered signature of the right shape is refused", async () => {
  const token = await buildManageToken(CAP, 1, LIVE, lookup);
  const [v, id, sig] = token.split(".");
  const flipped = (sig.endsWith("A") ? "B" : "A") + sig.slice(1);
  assertEquals(await verifyManageToken(`${v}.${id}.${flipped}`, LIVE, lookup), { ok: false, reason: "invalid" });
});

Deno.test("the signed generation must EQUAL the row's stored generation", async () => {
  const ok = await verifyManageToken(await buildManageToken(CAP, 1, LIVE, lookup), LIVE, lookup);
  assertEquals(bindManageTokenToRow(ok, { found: true, keyVersion: 1 }),
    { ok: true, capabilityId: CAP, keyVersion: 1 });
  assertEquals(bindManageTokenToRow(ok, { found: true, keyVersion: 2 }),
    { ok: false, reason: "invalid" });                                   // other generation
  assertEquals(bindManageTokenToRow(ok, { found: false }), { ok: false, reason: "invalid" });
  // ...and an UNREADABLE row is RETRYABLE, never the uniform rejection: a Supabase failure yields
  // data:null, and treating that as "no such row" would answer 200 and lose a real opt-out.
  assertEquals(bindManageTokenToRow(ok, { unavailable: true }), { ok: false, reason: "key_unavailable" });
  // an already-failed result passes through unchanged rather than being "upgraded"
  assertEquals(bindManageTokenToRow({ ok: false, reason: "key_unavailable" }, { found: true, keyVersion: 1 }),
    { ok: false, reason: "key_unavailable" });
});

Deno.test("a NEVER-ISSUED generation is a forgery, not an operational fault", async () => {
  // Otherwise v9999.<uuid>.<43 valid chars> would mint 503s and ops alerts from unauthenticated
  // traffic — an amplification vector with no signature required.
  let loads = 0;
  const counting: KeyLookup = (v) => { loads++; return keys[v]; };
  const sig = (await buildManageToken(CAP, 1, LIVE, lookup)).split(".")[2];
  assertEquals(await verifyManageToken(`v9999.${CAP}.${sig}`, LIVE, counting),
    { ok: false, reason: "invalid" });
  assertEquals(loads, 0);
});

Deno.test("a MISSING or incoherent key state is operational — never a silent accept", async () => {
  const token = await buildManageToken(CAP, 1, LIVE, lookup);
  for (const bad of [
    null,
    st(0, 0), st(1, 0),                         // floor below 1
    st(1, 2),                                   // current below the floor
    { currentVersion: NaN, minMintableVersion: 1 } as ManageKeyState,
    { currentVersion: 2, minMintableVersion: NaN } as ManageKeyState,
  ]) {
    assertEquals(await verifyManageToken(token, bad, lookup), { ok: false, reason: "key_unavailable" });
  }
});

Deno.test("ATTACHMENT refuses a retired generation — a dead link is never printed", async () => {
  // The database refuses to mint or hand back a retired capability, but attachment can happen
  // later in the same worker pass. This is the last moment before the link goes into an email:
  // a recipient cannot tell a broken unsubscribe from an ignored one.
  await assertRejects(
    () => buildManageToken(CAP, 1, st(2, 2), lookup),
    Error,
    "is RETIRED",
  );
  // ...and a generation above the current one is refused too
  await assertRejects(
    () => buildManageToken(CAP, 2, st(1, 1), (v) => (v === 2 ? K2 : K1)),
    Error,
    "above the current generation",
  );
  // ...and a missing/incoherent state stops the send rather than guessing
  await assertRejects(() => buildManageToken(CAP, 1, null, lookup), Error, "missing or incoherent");
  await assertRejects(() => buildManageToken(CAP, 1, st(1, 2), lookup), Error, "missing or incoherent");
});

Deno.test("the token is URL-safe end to end", async () => {
  const token = await buildManageToken(CAP, 1, LIVE, lookup);
  assertEquals(encodeURIComponent(token), token);
});

Deno.test("minting refuses an unconfigured key, a weak key, and a bad id or version", async () => {
  await assertRejects(() => buildManageToken(CAP, 9, st(9, 1), lookup), Error, "no signing key configured");
  await assertRejects(
    () => buildManageToken(CAP, 1, LIVE, () => "not-32-bytes-of-hex"),
    Error,
    "32 random bytes",
  );
  await assertRejects(() => buildManageToken("nope", 1, LIVE, lookup), Error, "not a uuid");
  await assertRejects(() => buildManageToken(CAP, 0, LIVE, lookup), Error, "positive int");
  // the ceiling is the DATABASE's, so a legal key_version can always be minted and verified
  await assertRejects(() => buildManageToken(CAP, 2147483648, st(2147483647, 1), lookup), Error, "positive int");
  const top: KeyLookup = () => K1;
  const t = await buildManageToken(CAP, 2147483647, st(2147483647, 1), top);
  assertEquals(
    await verifyManageToken(t, st(2147483647, 1), top),
    { ok: true, capabilityId: CAP, keyVersion: 2147483647 },
  );
});
