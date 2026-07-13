import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { canonicalizeSeriesCohort, cohortPersonKey, type CohortBooking } from "./rebook-cohort.ts";

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

Deno.test("23505 GUARD: a linked booking (BOTH ids) + a pure-guest booking of the same guest collapse to ONE guest claim", () => {
  const cohort = canonicalizeSeriesCohort([
    { player_id: P, guest_player_id: G }, // linked booking (both ids) — the crash vector
    { player_id: null, guest_player_id: G }, // pure-guest booking of the SAME guest
  ]);
  assertEquals(cohort, [{ player_id: null, guest_player_id: G }]);
  assertNoDuplicateIdentity(cohort);
});

Deno.test("a dual-keyed booking resolves to the GUEST person (FAM-02 Level 1: linked ≠ merged)", () => {
  const cohort = canonicalizeSeriesCohort([{ player_id: P, guest_player_id: G }]);
  assertEquals(cohort, [{ player_id: null, guest_player_id: G }]);
});

Deno.test("FAM-02 regression: a parent's own booking + their linked child's booking yield TWO claims — the child keeps their seat/invite", () => {
  const cohort = canonicalizeSeriesCohort([
    { player_id: P, guest_player_id: null }, // the parent, booked on their own profile
    { player_id: P, guest_player_id: G }, // the linked child (linker stamped the parent's id)
  ]);
  assertEquals(cohort.length, 2);
  assertEquals(cohort.some((c) => c.player_id === P && c.guest_player_id === null), true);
  assertEquals(cohort.some((c) => c.player_id === null && c.guest_player_id === G), true);
  assertNoDuplicateIdentity(cohort);
});

Deno.test("two DIFFERENT players' bookings sharing one guest_player_id are ONE person (the guest) — one claim, no guest collision", () => {
  const cohort = canonicalizeSeriesCohort([
    { player_id: P, guest_player_id: G },
    { player_id: P2, guest_player_id: G },
  ]);
  assertEquals(cohort, [{ player_id: null, guest_player_id: G }]);
  assertNoDuplicateIdentity(cohort);
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

Deno.test("order-independent: bare guest booking + linked booking of the same guest → one guest claim either way", () => {
  const cohort = canonicalizeSeriesCohort([
    { player_id: null, guest_player_id: G },
    { player_id: P, guest_player_id: G },
  ]);
  assertEquals(cohort, [{ player_id: null, guest_player_id: G }]);
  assertNoDuplicateIdentity(cohort);
});

Deno.test("rows with no identity at all are skipped; empty input → empty cohort", () => {
  assertEquals(canonicalizeSeriesCohort([]), []);
  assertEquals(canonicalizeSeriesCohort([{ player_id: null, guest_player_id: null }]), []);
});

Deno.test("mixed realistic series: 1 registered, 1 linked guest, 1 pure guest → 3 clean XOR claims (the linked guest keeps their own identity)", () => {
  const cohort = canonicalizeSeriesCohort([
    { player_id: P, guest_player_id: null },
    { player_id: P2, guest_player_id: G },
    { player_id: null, guest_player_id: G2 },
    { player_id: null, guest_player_id: G }, // duplicate of the linked guest → collapses into g:G
  ]);
  assertEquals(cohort.length, 3);
  assertEquals(cohort.some((c) => c.player_id === P), true);
  assertEquals(cohort.some((c) => c.guest_player_id === G), true);
  assertEquals(cohort.some((c) => c.guest_player_id === G2), true);
  // P2 no longer appears: their only booking in this series was the linked guest's.
  assertEquals(cohort.some((c) => c.player_id === P2), false);
  assertNoDuplicateIdentity(cohort);
});

Deno.test("cohortPersonKey mirrors the canonicalizer (guest-first) — preview counts can't diverge from claims", () => {
  assertEquals(cohortPersonKey({ player_id: P, guest_player_id: G }), `g:${G}`);
  assertEquals(cohortPersonKey({ player_id: P, guest_player_id: null }), P);
  assertEquals(cohortPersonKey({ player_id: null, guest_player_id: G }), `g:${G}`);
  assertEquals(cohortPersonKey({ player_id: null, guest_player_id: null }), null);
  // Every canonical cohort entry keys to itself.
  for (const b of canonicalizeSeriesCohort([
    { player_id: P, guest_player_id: null },
    { player_id: P2, guest_player_id: G },
  ])) {
    assertEquals(cohortPersonKey(b) !== null, true);
  }
});
