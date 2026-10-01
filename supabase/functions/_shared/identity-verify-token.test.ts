/**
 * The identity-verification capability token — mint/verify/bind, and every refusal.
 *
 * Mirrors manage-token.test.ts: the token is the same reviewed HMAC shape with its own domain
 * separation and key env. What matters is that a forged/tampered/retired/never-issued token is
 * refused with the RIGHT tag (invalid vs inactive vs the retryable key_unavailable), and that a
 * signature can never be lifted across generations or bound to the wrong row.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  bindIdentityTokenToRow,
  buildIdentityToken,
  type IdentityKeyState,
  type KeyLookup,
  verifyIdentityToken,
} from "./identity-verify-token.ts";

const KEY_V1 = "a".repeat(64);
const KEY_V2 = "b".repeat(64);
const CH = "11111111-2222-4333-8444-555555555555";
const lookup: KeyLookup = (v) => (v === 1 ? KEY_V1 : v === 2 ? KEY_V2 : undefined);
const state = (cur: number, min: number): IdentityKeyState => ({ currentVersion: cur, minMintableVersion: min });

Deno.test("mint then verify is a round trip", async () => {
  const token = await buildIdentityToken(CH, 1, state(1, 1), lookup);
  const r = await verifyIdentityToken(token, state(1, 1), lookup);
  assertEquals(r, { ok: true, challengeId: CH, keyVersion: 1 });
});

Deno.test("the token carries no PII — only v<N>.<uuid>.<43-char sig>", async () => {
  const token = await buildIdentityToken(CH, 1, state(1, 1), lookup);
  const [v, id, sig] = token.split(".");
  assertEquals(v, "v1");
  assertEquals(id, CH);
  assertEquals(sig.length, 43);
});

Deno.test("a tampered signature is invalid", async () => {
  const token = await buildIdentityToken(CH, 1, state(1, 1), lookup);
  const bad = token.slice(0, -1) + (token.at(-1) === "A" ? "B" : "A");
  assertEquals(await verifyIdentityToken(bad, state(1, 1), lookup), { ok: false, reason: "invalid" });
});

Deno.test("a signature cannot be lifted to another challenge id", async () => {
  const token = await buildIdentityToken(CH, 1, state(1, 1), lookup);
  const other = "99999999-2222-4333-8444-555555555555";
  const swapped = `v1.${other}.${token.split(".")[2]}`;
  assertEquals(await verifyIdentityToken(swapped, state(1, 1), lookup), { ok: false, reason: "invalid" });
});

Deno.test("a version ABOVE the current generation is a forgery (invalid), never key_unavailable", async () => {
  const forged = `v9999.${CH}.${"A".repeat(43)}`;
  assertEquals(await verifyIdentityToken(forged, state(1, 1), lookup), { ok: false, reason: "invalid" });
});

Deno.test("a RETIRED generation is inactive, decided before the key load", async () => {
  const token = await buildIdentityToken(CH, 1, state(2, 1), lookup);   // signed under v1
  // floor raised to 2: v1 is burned
  assertEquals(await verifyIdentityToken(token, state(2, 2), lookup), { ok: false, reason: "inactive" });
});

Deno.test("a key missing inside the live window is key_unavailable (retryable), not invalid", async () => {
  const token = await buildIdentityToken(CH, 2, state(2, 1), lookup);
  const noV2: KeyLookup = (v) => (v === 1 ? KEY_V1 : undefined);
  assertEquals(await verifyIdentityToken(token, state(2, 1), noV2), { ok: false, reason: "key_unavailable" });
});

Deno.test("a missing/incoherent key state is key_unavailable (never silently invalid)", async () => {
  assertEquals(await verifyIdentityToken(`v1.${CH}.${"A".repeat(43)}`, null, lookup), { ok: false, reason: "key_unavailable" });
});

Deno.test("grammar refusals never reach a key load", async () => {
  for (const bad of ["", "onlyonepart", "v1.notauuid.sig", `v0.${CH}.${"A".repeat(43)}`, `v1.${CH}.tooshort`]) {
    assertEquals((await verifyIdentityToken(bad, state(1, 1), lookup)).ok, false, `should reject: ${bad}`);
  }
});

Deno.test("mint refuses a retired or above-current generation, and a weak key", async () => {
  let threw = 0;
  for (const attempt of [
    () => buildIdentityToken(CH, 1, state(2, 2), lookup),           // retired
    () => buildIdentityToken(CH, 3, state(2, 1), lookup),           // above current
    () => buildIdentityToken(CH, 1, state(1, 1), () => "short"),    // weak key
    () => buildIdentityToken("not-a-uuid", 1, state(1, 1), lookup), // bad id
  ]) {
    try { await attempt(); } catch { threw++; }
  }
  assertEquals(threw, 4);
});

Deno.test("bindToRow requires the stored generation to equal the signed one", async () => {
  const good = { ok: true as const, challengeId: CH, keyVersion: 2 };
  assertEquals(bindIdentityTokenToRow(good, { found: true, keyVersion: 2 }), good);
  assertEquals(bindIdentityTokenToRow(good, { found: true, keyVersion: 1 }), { ok: false, reason: "invalid" });
  assertEquals(bindIdentityTokenToRow(good, { found: false }), { ok: false, reason: "invalid" });
  assertEquals(bindIdentityTokenToRow(good, { unavailable: true }), { ok: false, reason: "key_unavailable" });
  // a failed verification is passed through unchanged
  const bad = { ok: false as const, reason: "inactive" as const };
  assertEquals(bindIdentityTokenToRow(bad, { found: true, keyVersion: 2 }), bad);
});
