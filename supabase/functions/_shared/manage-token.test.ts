import { assertEquals, assertRejects } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { buildManageToken, verifyManageToken, type KeyLookup } from "./manage-token.ts";

// N2 — the manage-link token. What these pin, in order of how badly each would hurt:
//   * a token is verified against the key the ROW names, never against whichever loaded key
//     happens to match — otherwise retiring a key would do nothing until someone remembered to
//     delete it from the environment;
//   * the retirement floor is enforced BEFORE any database read;
//   * every failure looks the same (null), so the endpoint is not an oracle;
//   * minting is deterministic, which is what keeps a retry's email byte-identical under an
//     unchanged provider idempotency key.

const CAP = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const keys: Record<number, string> = { 1: "key-one-secret", 2: "key-two-secret" };
const lookup: KeyLookup = (v) => keys[v];
/** the database's answer for "which key signed this capability" */
const storedVersion = (version: number | null) => async () => version;

Deno.test("a token verifies against the version the row names", async () => {
  const token = await buildManageToken(CAP, 1, lookup);
  assertEquals(await verifyManageToken(token, storedVersion(1), 1, lookup), CAP);
});

Deno.test("minting is deterministic — a retry rebuilds the same bytes", async () => {
  const a = await buildManageToken(CAP, 1, lookup);
  const b = await buildManageToken(CAP, 1, lookup);
  assertEquals(a, b);
});

Deno.test("different capabilities and different keys produce different signatures", async () => {
  const a = await buildManageToken(CAP, 1, lookup);
  const b = await buildManageToken(OTHER, 1, lookup);
  const c = await buildManageToken(CAP, 2, lookup);
  assertEquals(a === b, false);
  assertEquals(a === c, false);
});

Deno.test("a token signed by ANOTHER loaded key is refused — no trial-and-accept", async () => {
  // The whole point of per-row version binding: v2 is still configured and still valid for other
  // capabilities, but this row says v1 signed it, so a v2 signature is not this token.
  const forged = await buildManageToken(CAP, 2, lookup);
  assertEquals(await verifyManageToken(forged, storedVersion(1), 1, lookup), null);
});

Deno.test("a RETIRED key is refused before any database read", async () => {
  const token = await buildManageToken(CAP, 1, lookup);
  let reads = 0;
  const counting = async () => { reads++; return 1; };
  // floor raised to 2 → the v1 row is retired
  assertEquals(await verifyManageToken(token, counting, 2, lookup), null);
  // the row lookup happens (it is how we learn the version), but nothing beyond it is attempted
  assertEquals(reads, 1);
});

Deno.test("an unknown capability, a missing key, and a lookup failure all read as null", async () => {
  const token = await buildManageToken(CAP, 1, lookup);
  assertEquals(await verifyManageToken(token, storedVersion(null), 1, lookup), null);
  assertEquals(await verifyManageToken(token, storedVersion(9), 1, lookup), null);
  const throwing = async () => { throw new Error("database unreachable"); };
  assertEquals(await verifyManageToken(token, throwing, 1, lookup), null);
});

Deno.test("malformed tokens are refused without touching the database", async () => {
  let reads = 0;
  const counting = async () => { reads++; return 1; };
  for (const bad of [
    null, undefined, "", ".", `${CAP}.`, `.sig`, CAP, "not-a-uuid.sig",
    `${CAP}x.sig`, ` ${CAP}.sig`,
  ]) {
    assertEquals(await verifyManageToken(bad as string | null, counting, 1, lookup), null, `${bad}`);
  }
  assertEquals(reads, 0);
});

Deno.test("a tampered signature is refused", async () => {
  const token = await buildManageToken(CAP, 1, lookup);
  const [id, sig] = token.split(".");
  const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
  assertEquals(await verifyManageToken(`${id}.${flipped}`, storedVersion(1), 1, lookup), null);
  // ...and a signature of the right shape but the wrong length is not a length-oracle either
  assertEquals(await verifyManageToken(`${id}.${sig.slice(0, -2)}`, storedVersion(1), 1, lookup), null);
});

Deno.test("the token is URL-safe: base64url, unpadded", async () => {
  const token = await buildManageToken(CAP, 1, lookup);
  const sig = token.split(".")[1];
  assertEquals(/^[A-Za-z0-9_-]+$/.test(sig), true, sig);
  assertEquals(encodeURIComponent(token), token);
});

Deno.test("minting with an unconfigured key THROWS rather than emitting a linkless footer", async () => {
  await assertRejects(
    () => buildManageToken(CAP, 3, lookup),
    Error,
    "no signing key configured for version 3",
  );
});
