/**
 * buildIntentKey — the ONE canonical material-intent serializer (Codex r3 convergence). It must be
 * stable across key order, sensitive to EVERY field (so a verified selection binds the whole
 * booking, not a subset), and versioned.
 */
import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildIntentKey } from "./identity-intent.ts";

Deno.test("object key ORDER does not change the digest", () => {
  const a = buildIntentKey("slot", { slotId: "s1", email: "a@b.com", phone: "06", notes: "hi" });
  const b = buildIntentKey("slot", { notes: "hi", phone: "06", email: "a@b.com", slotId: "s1" });
  assertEquals(a, b);
});

Deno.test("nested object key order also does not matter", () => {
  const a = buildIntentKey("intake", { metadata: { x: 1, y: 2 }, email: "a@b.com" });
  const b = buildIntentKey("intake", { email: "a@b.com", metadata: { y: 2, x: 1 } });
  assertEquals(a, b);
});

Deno.test("ANY field change changes the digest — including consent and notes", () => {
  const base = { slotId: "s1", email: "a@b.com", phone: "06", notes: "hi", whatsappOptIn: false };
  const key = buildIntentKey("slot", base);
  assertNotEquals(key, buildIntentKey("slot", { ...base, notes: "different" }));
  assertNotEquals(key, buildIntentKey("slot", { ...base, whatsappOptIn: true }));
  assertNotEquals(key, buildIntentKey("slot", { ...base, phone: "07" }));
  assertNotEquals(key, buildIntentKey("slot", { ...base, slotId: "s2" }));
});

Deno.test("the workflow is part of the identity", () => {
  const fields = { email: "a@b.com" };
  assertNotEquals(buildIntentKey("slot", fields), buildIntentKey("cart", fields));
});

Deno.test("array ELEMENT order is significant (kept as submitted) but callers pre-sort sets", () => {
  // time windows are order-meaningful, so [a,b] != [b,a]; the cart pre-sorts its slot-id SET before
  // calling, which this does not undo.
  assertNotEquals(
    buildIntentKey("intake", { preferredDays: ["mon", "tue"] }),
    buildIntentKey("intake", { preferredDays: ["tue", "mon"] }),
  );
});

Deno.test("the scheme is versioned", () => {
  assertEquals(buildIntentKey("slot", {}).startsWith('["v1","slot"'), true);
});
