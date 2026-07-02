import { assert, assertEquals, assertNotEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { canonicalStringify, mollieIdempotencyKey } from "./mollie-idempotency.ts";

// A representative Mollie payment body (shape mirrors what the charge fns build).
const body = (over: Record<string, unknown> = {}) => ({
  amount: { currency: "EUR", value: "30.00" },
  description: "Padel training",
  redirectUrl: "https://padeltrainer.ai/booking/tok?status=success",
  webhookUrl: "https://x.supabase.co/functions/v1/mollie-webhook",
  profileId: "pfl_x",
  metadata: { booking_id: "b1", booking_ids: ["b1", "b2"], recipient_type: "academy" },
  ...over,
});

Deno.test("key is deterministic — an IDENTICAL retry body reproduces it (Mollie replays)", async () => {
  const a = await mollieIdempotencyKey("cmp", body());
  const b = await mollieIdempotencyKey("cmp", body());
  assertEquals(a, b);
});

Deno.test("key is 40 hex chars (compact, within any server limit)", async () => {
  const k = await mollieIdempotencyKey("gcp", body());
  assertEquals(k.length, 40);
  assert(/^[0-9a-f]{40}$/.test(k), `expected 40 hex chars, got ${k}`);
});

Deno.test("insertion order of body keys does NOT change the key", async () => {
  const a = await mollieIdempotencyKey("cmp", { amount: { value: "30.00" }, description: "x", profileId: "p" });
  const b = await mollieIdempotencyKey("cmp", { profileId: "p", description: "x", amount: { value: "30.00" } });
  assertEquals(a, b);
});

Deno.test("array order IS significant — key is a FAITHFUL fingerprint of the raw body", async () => {
  // Mollie diffs the RAW body against the key, so the key must track array order too
  // (callers are responsible for sorting booking_ids into a canonical order BEFORE
  // building the body — see the fns). If the key ignored order, a reordered raw body
  // under the same key would be a same-key/different-body 400.
  const a = await mollieIdempotencyKey("gcp", body({ metadata: { booking_ids: ["b1", "b2", "b3"] } }));
  const b = await mollieIdempotencyKey("gcp", body({ metadata: { booking_ids: ["b3", "b1", "b2"] } }));
  assertNotEquals(a, b);
  // ...and a canonically-sorted body reproduces its key exactly across a retry.
  const s1 = await mollieIdempotencyKey("gcp", body({ metadata: { booking_ids: [...["b3", "b1", "b2"]].sort() } }));
  const s2 = await mollieIdempotencyKey("gcp", body({ metadata: { booking_ids: [...["b1", "b3", "b2"]].sort() } }));
  assertEquals(s1, s2);
});

Deno.test("a DIFFERENT body → a DIFFERENT key (so Mollie never 400s on same-key/different-body)", async () => {
  // amount drift (split re-division)
  assertNotEquals(await mollieIdempotencyKey("cmp", body()), await mollieIdempotencyKey("cmp", body({ amount: { currency: "EUR", value: "20.00" } })));
  // a freshly-minted booking id in metadata (the pre-booking single path)
  assertNotEquals(
    await mollieIdempotencyKey("cmp", body({ metadata: { booking_id: "A" } })),
    await mollieIdempotencyKey("cmp", body({ metadata: { booking_id: "B" } })),
  );
  // an applicationFee change (fee override / tier crossing the >0 boundary)
  assertNotEquals(
    await mollieIdempotencyKey("cmp", body()),
    await mollieIdempotencyKey("cmp", body({ applicationFee: { amount: { currency: "EUR", value: "1.00" } } })),
  );
});

Deno.test("different scopes never collide for the same body", async () => {
  assertNotEquals(await mollieIdempotencyKey("cmp", body()), await mollieIdempotencyKey("gsp", body()));
  assertNotEquals(await mollieIdempotencyKey("gsp", body()), await mollieIdempotencyKey("cip", body()));
});

Deno.test("canonicalStringify sorts object keys but PRESERVES array order (faithful to raw body)", () => {
  assertEquals(canonicalStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
  // arrays keep their order — order is what Mollie diffs in the raw body
  assertEquals(canonicalStringify(["c", "a", "b"]), '["c","a","b"]');
  assertEquals(canonicalStringify([{ x: 2 }, { x: 1 }]), '[{"x":2},{"x":1}]');
  // nested objects inside arrays also get key-sorted
  assertEquals(canonicalStringify([{ b: 1, a: 2 }]), '[{"a":2,"b":1}]');
  // undefined-valued keys are OMITTED (mirrors JSON.stringify — the raw body Mollie sees)
  assertEquals(canonicalStringify({ a: 1, b: undefined }), '{"a":1}');
  assertEquals(canonicalStringify({ a: 1 }), canonicalStringify({ a: 1, b: undefined }));
});
