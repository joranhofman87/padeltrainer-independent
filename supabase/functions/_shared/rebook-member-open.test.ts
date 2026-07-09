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

Deno.test("RB03: alreadyNotifiedKeys excludes recipients emailed in a prior run (cohort + guest + priority)", () => {
  const audience = computeMemberOpenAudience(
    [
      claim({ player_id: "p2", status: "pending" }),
      claim({ player_id: "p3", status: "expired" }),
      claim({ guest_player_id: "g1", status: "pending" }),
    ],
    ["p9"],
    [],
    { alreadyNotifiedKeys: ["p2", "g:g1"] },
  );
  // p2 (cohort) and g1 (guest) already emailed ⇒ retry only re-sends p3 + the priority p9.
  assertEquals(keys(audience), ["p3", "p9"]);
});

Deno.test("RB03: a priority-list person already emailed is not re-added", () => {
  const audience = computeMemberOpenAudience([], ["p9", "p8"], [], { alreadyNotifiedKeys: ["p9"] });
  assertEquals(keys(audience), ["p8"]);
});

Deno.test("RB03: empty alreadyNotifiedKeys is a no-op", () => {
  const audience = computeMemberOpenAudience([claim({ player_id: "p2", status: "pending" })], [], [], {
    alreadyNotifiedKeys: [],
  });
  assertEquals(keys(audience), ["p2"]);
});

Deno.test("priority GUESTS: added as guest recipients, deduped vs cohort + skipped once rebooked", () => {
  const audience = computeMemberOpenAudience(
    [
      claim({ guest_player_id: "g1", status: "pending" }), // cohort guest, also on the list → one entry
      claim({ guest_player_id: "g2", status: "claimed" }), // already rebooked → never emailed
    ],
    [],
    ["g1", "g2", "g3"], // priority guests
  );
  assertEquals(keys(audience), ["g:g1", "g:g3"]);
});

Deno.test("priority guests honor alreadyNotifiedKeys (g:<id>) on a retry", () => {
  const audience = computeMemberOpenAudience([], [], ["g5", "g6"], { alreadyNotifiedKeys: ["g:g5"] });
  assertEquals(keys(audience), ["g:g6"]);
});
