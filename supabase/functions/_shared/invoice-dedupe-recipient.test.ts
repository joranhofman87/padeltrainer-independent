import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import {
  applyDedupRecipientScope,
  dedupRecipientMatch,
  type RecipientScopableQuery,
} from "./invoice-dedupe-recipient.ts";

// Records the .eq()/.is() calls a fallback would apply, standing in for the
// supabase-js query builder so we can assert the exact recipient scope.
function fakeQuery() {
  const calls: Array<[string, string, string | null]> = [];
  const q: RecipientScopableQuery & { calls: typeof calls } = {
    calls,
    eq(column: string, value: string) {
      calls.push(["eq", column, value]);
      return q;
    },
    is(column: string, value: null) {
      calls.push(["is", column, value]);
      return q;
    },
  };
  return q;
}

Deno.test("dedupRecipientMatch — guest-first (FAM-02)", () => {
  assertEquals(dedupRecipientMatch("P", null), { kind: "profile", playerId: "P" });
  assertEquals(dedupRecipientMatch(null, "G"), { kind: "guest", guestPlayerId: "G" });
  // The crux: a DUAL-KEY payload resolves to the GUEST, never the profile.
  assertEquals(dedupRecipientMatch("P", "G"), { kind: "guest", guestPlayerId: "G" });
  assertEquals(dedupRecipientMatch(null, null), null);
  assertEquals(dedupRecipientMatch("", ""), null); // empty strings are falsy → no recipient
});

Deno.test("applyDedupRecipientScope — pure-profile scopes to player_id AND guest_player_id IS NULL", () => {
  const q = fakeQuery();
  applyDedupRecipientScope(q, "P", null);
  assertEquals(q.calls, [["eq", "player_id", "P"], ["is", "guest_player_id", null]]);
});

Deno.test("applyDedupRecipientScope — guest-only scopes to guest_player_id", () => {
  const q = fakeQuery();
  applyDedupRecipientScope(q, null, "G");
  assertEquals(q.calls, [["eq", "guest_player_id", "G"]]);
});

Deno.test("applyDedupRecipientScope — DUAL-KEY scopes to the GUEST, never the profile (guards the 23505 fix)", () => {
  const q = fakeQuery();
  applyDedupRecipientScope(q, "P", "G");
  // Must be guest-scoped ONLY. A recipient-agnostic (no calls) or player-first
  // (`eq player_id`) regression — which reopened the paid-flip bug — fails here.
  assertEquals(q.calls, [["eq", "guest_player_id", "G"]]);
});

Deno.test("applyDedupRecipientScope — no recipient applies no scope", () => {
  const q = fakeQuery();
  applyDedupRecipientScope(q, null, null);
  assertEquals(q.calls, []);
});
