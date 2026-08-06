import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { gateDigestItems, normalizeEmailForSuppression } from "./digest-send-gate.ts";

/**
 * N2 S2b — the send-time gate's decision table.
 *
 * The invariant under test is the J rule: ONLY an explicit `off` refuses. Everything else — a
 * missing row, an unknown column, a cadence that changed since enqueue — still sends, because the
 * item was queued by an affirmative choice and `off` is the only value that is safe to obey
 * whatever its origin.
 */

const item = (id: string, type: string) => ({ id, notification_type: type });

Deno.test("an item whose CURRENT preference is 'off' is dropped, not sent", () => {
  const d = gateDigestItems([item("a", "new_booking")], { new_booking: "off" });
  assertEquals(d.send.length, 0);
  assertEquals(d.droppedOff.map((i) => i.id), ["a"]);
});

Deno.test("instant / daily / weekly all still send — a cadence change is not an opt-out", () => {
  for (const cadence of ["instant", "daily", "weekly"]) {
    const d = gateDigestItems([item("a", "new_booking")], { new_booking: cadence });
    assertEquals(d.send.map((i) => i.id), ["a"], `cadence=${cadence}`);
    assertEquals(d.droppedOff.length, 0, `cadence=${cadence}`);
  }
});

Deno.test("no preferences row at all → everything sends (no expressible opt-out)", () => {
  const d = gateDigestItems([item("a", "new_booking"), item("b", "new_review")], null);
  assertEquals(d.send.map((i) => i.id), ["a", "b"]);
  assertEquals(d.droppedOff.length, 0);
});

Deno.test("a type with no matching column sends — absence of a lever is not an opt-out", () => {
  const d = gateDigestItems([item("a", "some_future_type")], { new_booking: "off" });
  assertEquals(d.send.map((i) => i.id), ["a"]);
});

Deno.test("mixed batch splits per item, order preserved within each side", () => {
  const d = gateDigestItems(
    [item("a", "new_booking"), item("b", "new_review"), item("c", "new_booking"), item("d", "waitlist_update")],
    { new_booking: "off", new_review: "daily", waitlist_update: "off" },
  );
  assertEquals(d.send.map((i) => i.id), ["b"]);
  assertEquals(d.droppedOff.map((i) => i.id), ["a", "c", "d"]);
});

Deno.test("empty claim → both sides empty (the caller then consumes nothing and sends nothing)", () => {
  const d = gateDigestItems([], { new_booking: "off" });
  assertEquals(d.send.length, 0);
  assertEquals(d.droppedOff.length, 0);
});

Deno.test("a non-string junk value in the column does NOT drop — only the literal 'off' refuses", () => {
  // Fail-open on junk is deliberate: dropping on anything unrecognised would let a corrupted row
  // silently swallow mail the person opted into; `off` is the only value with opt-out semantics.
  for (const junk of [null, undefined, 0, false, "OFF", "disabled"]) {
    const d = gateDigestItems([item("a", "new_booking")], { new_booking: junk });
    assertEquals(d.send.length, 1, `junk=${String(junk)}`);
  }
});

Deno.test("normalizeEmailForSuppression matches lower(btrim(...))", () => {
  assertEquals(normalizeEmailForSuppression("  User@Example.COM  "), "user@example.com");
  assertEquals(normalizeEmailForSuppression("plain@x.nl"), "plain@x.nl");
});
