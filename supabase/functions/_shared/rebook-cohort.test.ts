import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { canonicalizeSeriesCohort, type CohortBooking } from "./rebook-cohort.ts";

const P = "11111111-1111-1111-1111-111111111111";
const P2 = "22222222-2222-2222-2222-222222222222";
const G = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const G2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

/** The exact DB invariant the two partial unique indexes enforce: no two claims may share a non-null
 *  player_id, nor a non-null guest_player_id (per slot — the cohort is per-series so this is it). */
function assertNoDuplicateIdentity(cohort: CohortBooking[]) {
  const players = cohort.map((c) => c.player_id).filter((x): x is string => !!x);
  const guests = cohort.map((c) => c.guest_player_id).filter((x): x is string => !!x);
  assertEquals(new Set(players).size, players.length, "duplicate non-null player_id → uq_slot_player 23505");
  assertEquals(new Set(guests).size, guests.length, "duplicate non-null guest_player_id → uq_slot_guest 23505");
}

Deno.test("23505 GUARD: a guest linked to a profile (booking with BOTH ids) + a pure-guest booking of the same guest collapse to ONE claim", () => {
  const cohort = canonicalizeSeriesCohort([
    { player_id: P, guest_player_id: G }, // linked booking (both ids) — the crash vector
    { player_id: null, guest_player_id: G }, // pure-guest booking of the SAME guest
  ]);
  assertEquals(cohort, [{ player_id: P, guest_player_id: null }]);
  assertNoDuplicateIdentity(cohort);
});

Deno.test("XOR: a booking carrying both ids yields a registered (player-only) claim, never a doubled guest", () => {
  const cohort = canonicalizeSeriesCohort([{ player_id: P, guest_player_id: G }]);
  assertEquals(cohort, [{ player_id: P, guest_player_id: null }]);
});

Deno.test("two DIFFERENT players sharing one guest_player_id stay two distinct registered claims (no guest collision)", () => {
  const cohort = canonicalizeSeriesCohort([
    { player_id: P, guest_player_id: G },
    { player_id: P2, guest_player_id: G },
  ]);
  assertEquals(cohort.length, 2);
  assertNoDuplicateIdentity(cohort);
  assertEquals(cohort.every((c) => c.guest_player_id === null), true);
});

Deno.test("pure guests: distinct guests kept, duplicate guest de-duped to one", () => {
  const cohort = canonicalizeSeriesCohort([
    { player_id: null, guest_player_id: G },
    { player_id: null, guest_player_id: G }, // same guest across two sessions
    { player_id: null, guest_player_id: G2 },
  ]);
  assertEquals(cohort, [
    { player_id: null, guest_player_id: G },
    { player_id: null, guest_player_id: G2 },
  ]);
  assertNoDuplicateIdentity(cohort);
});

Deno.test("registered players de-dupe by player_id across sessions", () => {
  const cohort = canonicalizeSeriesCohort([
    { player_id: P, guest_player_id: null },
    { player_id: P, guest_player_id: null },
    { player_id: P2, guest_player_id: null },
  ]);
  assertEquals(cohort, [
    { player_id: P, guest_player_id: null },
    { player_id: P2, guest_player_id: null },
  ]);
});

Deno.test("link learned from ANY session applies to a pure-guest booking on a DIFFERENT session (order-independent)", () => {
  // pure-guest booking comes FIRST, the linking booking second — the guest must still resolve to P.
  const cohort = canonicalizeSeriesCohort([
    { player_id: null, guest_player_id: G },
    { player_id: P, guest_player_id: G },
  ]);
  assertEquals(cohort, [{ player_id: P, guest_player_id: null }]);
  assertNoDuplicateIdentity(cohort);
});

Deno.test("rows with no identity at all are skipped; empty input → empty cohort", () => {
  assertEquals(canonicalizeSeriesCohort([]), []);
  assertEquals(canonicalizeSeriesCohort([{ player_id: null, guest_player_id: null }]), []);
});

Deno.test("mixed realistic series: 1 registered, 1 linked guest (both ids), 1 pure guest → 3 clean XOR claims", () => {
  const cohort = canonicalizeSeriesCohort([
    { player_id: P, guest_player_id: null },
    { player_id: P2, guest_player_id: G },
    { player_id: null, guest_player_id: G2 },
    { player_id: null, guest_player_id: G }, // duplicate of the linked guest → must collapse into P2
  ]);
  assertEquals(cohort.length, 3);
  assertNoDuplicateIdentity(cohort);
});
