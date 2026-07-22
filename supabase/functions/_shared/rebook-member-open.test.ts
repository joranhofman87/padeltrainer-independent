import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import {
  computeMemberOpenAudience, recipientKey, resolveMemberOpenContact,
  type MemberOpenClaim, type MemberOpenRecipient,
} from "./rebook-member-open.ts";

const claim = (over: Partial<MemberOpenClaim>): MemberOpenClaim => ({
  player_id: null, guest_player_id: null, status: "pending", response_intent: null, ...over,
});

const keys = (recips: MemberOpenRecipient[]) =>
  recips.map((r) => r.player_id ?? `g:${r.guest_player_id}`).sort();
// Guest-first canonical keys (what grouping + RB03 persistence actually use).
const canonicalKeys = (recips: MemberOpenRecipient[]) => recips.map(recipientKey).sort();

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

// ── PR 10d: FAM-02 guest-first identity ──────────────────────────────────────────────────────

Deno.test("FAM-02: a parent (pure profile) and their DUAL-KEY child stay SEPARATE recipients", () => {
  const audience = computeMemberOpenAudience(
    [
      claim({ player_id: "parent", status: "pending" }),                          // parent's own claim
      claim({ player_id: "parent", guest_player_id: "child", status: "pending" }), // dual-key child
    ],
    [],
  );
  // Guest-first canonical keys: parent stays bare (compat), the child is its OWN g:child — two people.
  assertEquals(canonicalKeys(audience), ["g:child", "parent"]);
});

Deno.test("FAM-02 RB03: an existing PARENT already-notified key does NOT suppress the child's first catch-up", () => {
  const audience = computeMemberOpenAudience(
    [claim({ player_id: "parent", guest_player_id: "child", status: "pending" })],
    [], [],
    { alreadyNotifiedKeys: ["parent"] }, // the old player-first key persisted before the fix
  );
  // The child now keys g:child, not "parent" → not suppressed → gets its one correct notification.
  assertEquals(canonicalKeys(audience), ["g:child"]);
});

Deno.test("FAM-02 RB03: once the child's guest key is persisted, a retry DOES suppress the duplicate", () => {
  const audience = computeMemberOpenAudience(
    [claim({ player_id: "parent", guest_player_id: "child", status: "pending" })],
    [], [],
    { alreadyNotifiedKeys: ["g:child"] },
  );
  assertEquals(audience, []);
});

Deno.test("FAM-02: existing pure-profile + guest-only persisted keys stay byte-for-byte compatible", () => {
  // A pure profile keys to its bare id and a pure guest to g:<id> — unchanged from before the fix,
  // so keys already stored in cycles.settings still match and never re-notify.
  assertEquals(recipientKey({ player_id: "p1", guest_player_id: null }), "p1");
  assertEquals(recipientKey({ player_id: null, guest_player_id: "g1" }), "g:g1");
  // Only a dual-key row moves — from the parent's id to the guest's own key.
  assertEquals(recipientKey({ player_id: "parent", guest_player_id: "child" }), "g:child");
});

Deno.test("FAM-02 contact: a dual-key child's OWN name + email win over the linked parent", () => {
  const nameByKey = new Map([["parent", "Parent"], ["g:child", "Child"]]);
  const emailByKey = new Map([["parent", "parent@x.com"], ["g:child", "child@x.com"]]);
  assertEquals(
    resolveMemberOpenContact({ player_id: "parent", guest_player_id: "child" }, nameByKey, emailByKey),
    { name: "Child", email: "child@x.com" },
  );
});

Deno.test("FAM-02 contact: parent inbox is the fallback ONLY when the child has no email (child's NAME still wins)", () => {
  const nameByKey = new Map([["parent", "Parent"], ["g:child", "Child"]]);
  const emailByKey = new Map([["parent", "parent@x.com"]]); // child has no own email
  assertEquals(
    resolveMemberOpenContact({ player_id: "parent", guest_player_id: "child" }, nameByKey, emailByKey),
    { name: "Child", email: "parent@x.com" },
  );
});

Deno.test("FAM-02 contact: a pure profile uses its own name/email; no deliverable email → dropped", () => {
  const nameByKey = new Map([["p1", "Solo"]]);
  const emailByKey = new Map([["p1", "solo@x.com"]]);
  assertEquals(resolveMemberOpenContact({ player_id: "p1", guest_player_id: null }, nameByKey, emailByKey),
    { name: "Solo", email: "solo@x.com" });
  // a guest with no own email and no linked parent → null (caller drops it)
  assertEquals(resolveMemberOpenContact({ player_id: null, guest_player_id: "g9" }, nameByKey, emailByKey), null);
});
