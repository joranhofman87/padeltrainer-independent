import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { computeMemberOpenAudience, type MemberOpenClaim, type MemberOpenRecipient } from "./rebook-member-open.ts";

const claim = (over: Partial<MemberOpenClaim>): MemberOpenClaim => ({
  player_id: null, guest_player_id: null, status: "pending", response_intent: null, ...over,
});

const keys = (recips: MemberOpenRecipient[]) =>
  recips.map((r) => r.player_id ?? `g:${r.guest_player_id}`).sort();

Deno.test("includes cohort non-rebookers (pending/expired), excludes rebookers", () => {
  const audience = computeMemberOpenAudience(
    [
      claim({ player_id: "p1", status: "claimed" }),
      claim({ player_id: "p2", status: "pending" }),
      claim({ player_id: "p3", status: "expired" }),
      claim({ guest_player_id: "g1", status: "pending" }),
    ],
    [],
  );
  assertEquals(keys(audience), ["g:g1", "p2", "p3"]);
});

Deno.test("excludes explicit decliners by default (status declined or response_intent decline)", () => {
  const audience = computeMemberOpenAudience(
    [
      claim({ player_id: "p1", status: "declined" }),
      claim({ player_id: "p2", status: "pending", response_intent: "decline" }),
      claim({ player_id: "p3", status: "pending" }),
    ],
    [],
  );
  assertEquals(keys(audience), ["p3"]);
});

Deno.test("includes decliners when excludeDecliners=false", () => {
  const audience = computeMemberOpenAudience(
    [claim({ player_id: "p1", status: "declined" }), claim({ player_id: "p2", status: "pending" })],
    [],
    { excludeDecliners: false },
  );
  assertEquals(keys(audience), ["p1", "p2"]);
});

Deno.test("adds the priority list and dedupes a priority person who is also a cohort non-rebooker", () => {
  const audience = computeMemberOpenAudience([claim({ player_id: "p2", status: "pending" })], ["p9", "p2"]);
  assertEquals(keys(audience), ["p2", "p9"]);
});

Deno.test("still emails a priority-list person who declined an old slot (the promise wins)", () => {
  const audience = computeMemberOpenAudience([claim({ player_id: "p1", status: "declined" })], ["p1"]);
  assertEquals(keys(audience), ["p1"]);
});

Deno.test("never emails a priority-list person who already rebooked", () => {
  const audience = computeMemberOpenAudience([claim({ player_id: "p1", status: "claimed" })], ["p1"]);
  assertEquals(audience, []);
});

Deno.test("collapses a person with multiple claims (one claimed anywhere ⇒ excluded)", () => {
  const audience = computeMemberOpenAudience(
    [claim({ player_id: "p1", status: "claimed" }), claim({ player_id: "p1", status: "expired" })],
    [],
  );
  assertEquals(audience, []);
});

Deno.test("returns empty for a fully-rebooked round with no priority list", () => {
  const audience = computeMemberOpenAudience(
    [claim({ player_id: "p1", status: "claimed" }), claim({ guest_player_id: "g1", status: "claimed" })],
    [],
  );
  assertEquals(audience, []);
});
