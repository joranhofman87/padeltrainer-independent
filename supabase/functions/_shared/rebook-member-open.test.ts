import { assert, assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import {
  computeMemberOpenAudience, recipientKey, resolveMemberOpenContact, runClaimedCycle,
  type MemberOpenClaim, type MemberOpenContactMaps, type MemberOpenRecipient,
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

const emptyMaps = (): MemberOpenContactMaps => ({
  profileName: new Map(), profileEmail: new Map(),
  guestOwnName: new Map(), guestOwnEmail: new Map(),
});

Deno.test("Pass B §2: a dual-key child is reached at their OWN name and email", () => {
  const m = emptyMaps();
  m.guestOwnName.set("child", "Child"); m.guestOwnEmail.set("child", "child@x.com");
  assertEquals(
    resolveMemberOpenContact({ player_id: "parent", guest_player_id: "child" }, m),
    { name: "Child", email: "child@x.com", needsSignup: true },
  );
});

Deno.test("Pass B §2: a guest with NO own email is unresolved — never an inherited account address", () => {
  const m = emptyMaps();
  // the account arms are gone entirely, so there is nothing to fall back to
  m.profileEmail.set("some-account", "account@x.com");
  assertEquals(resolveMemberOpenContact({ player_id: "some-account", guest_player_id: "g5" }, m), null);
});

Deno.test("Pass B §2: two guests sharing one stale account stay separate, each at their own address", () => {
  const m = emptyMaps();
  m.guestOwnName.set("gA", "Alpha"); m.guestOwnEmail.set("gA", "alpha@x.com");
  m.guestOwnName.set("gB", "Beta"); m.guestOwnEmail.set("gB", "beta@x.com");
  const a = resolveMemberOpenContact({ player_id: "shared", guest_player_id: "gA" }, m);
  const b = resolveMemberOpenContact({ player_id: "shared", guest_player_id: "gB" }, m);
  assertEquals(a, { name: "Alpha", email: "alpha@x.com", needsSignup: true });
  assertEquals(b, { name: "Beta", email: "beta@x.com", needsSignup: true });
});

Deno.test("Pass B §2: a guest's blank name is NOT filled in from an account", () => {
  const m = emptyMaps();
  m.guestOwnEmail.set("g6", "new@x.com");   // no own name
  m.profileName.set("acct", "Account Holder");
  assertEquals(
    resolveMemberOpenContact({ player_id: "acct", guest_player_id: "g6" }, m),
    { name: "", email: "new@x.com", needsSignup: true },
  );
});

Deno.test("RETAINED: a pure-profile recipient keeps direct profile contact and never needs signup", () => {
  const m = emptyMaps();
  m.profileName.set("p1", "Real Player"); m.profileEmail.set("p1", "player@x.com");
  assertEquals(
    resolveMemberOpenContact({ player_id: "p1", guest_player_id: null }, m),
    { name: "Real Player", email: "player@x.com", needsSignup: false },
  );
});

Deno.test("Pass B §2 PROOF: a raw dual-key player_id is never used to reach a guest", () => {
  const m = emptyMaps();
  m.guestOwnName.set("child", "Child"); m.guestOwnEmail.set("child", "child@x.com");
  m.profileEmail.set("unverified-parent", "parent@x.com"); // present but MUST be ignored for a guest
  assertEquals(
    resolveMemberOpenContact({ player_id: "unverified-parent", guest_player_id: "child" }, m),
    { name: "Child", email: "child@x.com", needsSignup: true },
  );
});

Deno.test("FAM-02 contact: a pure profile uses its own name/email and never needs signup; no email → dropped", () => {
  const m = emptyMaps();
  m.profileName.set("p1", "Solo"); m.profileEmail.set("p1", "solo@x.com");
  assertEquals(resolveMemberOpenContact({ player_id: "p1", guest_player_id: null }, m),
    { name: "Solo", email: "solo@x.com", needsSignup: false });
  // a guest with no own email and no verified account email → null (caller drops it)
  assertEquals(resolveMemberOpenContact({ player_id: null, guest_player_id: "g9" }, m), null);
});

// ── PR 10d: crash-recovery contract (Codex #2/#4) — a claimed cycle can never stay permanently
//    claimed with an unsent audience. runClaimedCycle is Resend-free, so we drive it with a fake
//    rpc client + a `notify` that throws/partials/succeeds. A throw stands in for ANY of notifyCycle's
//    fail-loud recipient-discovery read errors (cycle/slots/claims/contact/academy). ────────────────
const fakeRpc = (rpcError = false) => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return Promise.resolve({ error: rpcError ? { message: "unclaim boom" } : null });
    },
  };
  return { client, calls };
};
const released = (calls: Array<{ name: string }>) => calls.some((c) => c.name === "unclaim_rebook_member_open_notice");

Deno.test("runClaimedCycle: a thrown recipient-discovery read RELEASES the claim (never permanently claimed)", async () => {
  const { client, calls } = fakeRpc();
  const out = await runClaimedCycle(client, "cyc-1", () => Promise.reject(new Error("member-open slots read failed: boom")));
  assert(out.error?.includes("slots read failed"), out.error ?? "no error");
  assertEquals(out.released, true);
  assert(released(calls), "expected the claim to be released after a read error");
});

Deno.test("runClaimedCycle: a PARTIAL send releases the claim so the retry re-sends only failures", async () => {
  const { client, calls } = fakeRpc();
  const out = await runClaimedCycle(client, "cyc-1", () => Promise.resolve({ sent: 2, failed: 1 }));
  assertEquals(out.released, true);
  assertEquals(out.error, null);
  assert(released(calls));
});

Deno.test("runClaimedCycle: an UNCLAIM failure is surfaced (released=false)", async () => {
  const { client } = fakeRpc(/* rpcError */ true);
  const out = await runClaimedCycle(client, "cyc-1", () => Promise.reject(new Error("db down")));
  assertEquals(out.released, false);
  assert(out.error?.includes("unclaim failed"), out.error ?? "no error");
  assert(out.error?.includes("db down"), "original error should be preserved too");
});

Deno.test("runClaimedCycle: a fully-successful cycle does NOT release the claim (idempotent)", async () => {
  const { client, calls } = fakeRpc();
  const out = await runClaimedCycle(client, "cyc-1", () => Promise.resolve({ sent: 3, failed: 0 }));
  assertEquals(out, { sent: 3, failed: 0, released: false, error: null });
  assert(!released(calls), "a clean send must keep the claim (no re-notify)");
});
