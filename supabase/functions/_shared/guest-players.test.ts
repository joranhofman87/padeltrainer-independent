/**
 * The anonymous booking flows' Player identity.
 *
 * Two generations of behaviour are asserted ABSENT here. The first was the family rule: a
 * same-name row on the typed address was reused — a lookup deciding WHO was booking from two
 * attributes an unauthenticated stranger typed, which U2 removed. The second was the resolver's
 * RESULT: it used to answer with a guest row id (and threw when there was none), which made a
 * temporary legacy reference a precondition of taking a payment.
 *
 * What is asserted now: no lookup happens, the create carries the booker's own attempt id, the
 * resolver answers with CANONICAL identity only, and the legacy column `bookings` still needs is
 * derived by the service-only adapter — inside this service-key process, profile-first, loudly.
 */
import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";
import {
  legacyBookingRef,
  legacyGuestRefForCheckout,
  resolvePlayerForCheckout,
} from "./guest-players.ts";

const ACADEMY = "11111111-1111-4111-8111-111111111111";
const TRAINER = "22222222-2222-4222-8222-222222222222";
const REQ = "33333333-3333-4333-8333-333333333333";

type Recorded = { rpc: Array<{ fn: string; args: Record<string, unknown> }>; tables: string[] };

function makeAdmin(
  results: Record<string, unknown> = { player_create_command: { person_id: "the-person" } },
  error: { code: string; message: string } | null = null,
) {
  const rec: Recorded = { rpc: [], tables: [] };
  const admin = {
    from: (name: string) => {
      rec.tables.push(name);
      throw new Error("Player identity must not be resolved by querying tables");
    },
    rpc: (fn: string, args: Record<string, unknown>) => {
      rec.rpc.push({ fn, args });
      if (error) return Promise.resolve({ data: null, error });
      return Promise.resolve({ data: results[fn] ?? null, error: null });
    },
  } as unknown as SupabaseClient;
  return { admin, rec };
}

const name = { first_name: "Anna", last_name: "de Vries", full_name: "Anna de Vries" };

Deno.test("a booking creates its Player through the command, carrying the attempt id", async () => {
  const { admin, rec } = makeAdmin();
  const out = await resolvePlayerForCheckout(admin, {
    email: "Anna@Example.com",
    name,
    phone: "0612345678",
    owner: { academyProfileId: ACADEMY },
    source: "public_booking",
    creationRequestId: REQ,
  });

  assertEquals(out, { personId: "the-person" });
  assertEquals(rec.tables, [], "it queried a table");
  assertEquals(rec.rpc[0].fn, "player_create_command");
  assertEquals(rec.rpc[0].args._creation_request_id, REQ);
  assertEquals(rec.rpc[0].args._owner_type, "academy");
  assertEquals(rec.rpc[0].args._owner_id, ACADEMY);
  assertEquals(rec.rpc[0].args._email, "anna@example.com");
  assertEquals(rec.rpc[0].args._origin, "self_signup");
});

Deno.test("the checkout resolver answers with canonical identity and NOTHING else", async () => {
  // The contract the owner correction pins: no guest id in the resolver's answer, so no caller can
  // put one back into a response, a log line, or a piece of state.
  const { admin } = makeAdmin({
    player_create_command: { person_id: "the-person", guest_player_id: "smuggled" },
  });
  const out = await resolvePlayerForCheckout(admin, {
    email: "a@b.com", name, owner: { academyProfileId: ACADEMY }, creationRequestId: REQ,
  });
  assertEquals(Object.keys(out), ["personId"]);
});

Deno.test("a trainer-owned slot books against the trainer scope", async () => {
  const { admin, rec } = makeAdmin();
  await resolvePlayerForCheckout(admin, {
    email: "a@b.com", name, owner: { trainerId: TRAINER }, creationRequestId: REQ,
  });
  assertEquals(rec.rpc[0].args._owner_type, "trainer");
  assertEquals(rec.rpc[0].args._owner_id, TRAINER);
});

Deno.test("two bookers on ONE address are two creates — the address selects nobody", async () => {
  // The family case the old family rule existed for. It is no longer a rule about reuse: both
  // bookers create, each under their own attempt id, and the command proposes the duplicate.
  const parent = makeAdmin({ player_create_command: { person_id: "p-parent" } });
  const child = makeAdmin({ player_create_command: { person_id: "p-child" } });

  const a = await resolvePlayerForCheckout(parent.admin, {
    email: "family@example.com",
    name: { first_name: "Marieke", last_name: "de Vries", full_name: "Marieke de Vries" },
    owner: { academyProfileId: ACADEMY },
    creationRequestId: "44444444-4444-4444-8444-444444444444",
  });
  const b = await resolvePlayerForCheckout(child.admin, {
    email: "family@example.com",
    name,
    owner: { academyProfileId: ACADEMY },
    creationRequestId: "55555555-5555-4555-8555-555555555555",
  });

  assertEquals(a.personId !== b.personId, true);
  assertEquals(parent.rec.rpc[0].args._creation_request_id !== child.rec.rpc[0].args._creation_request_id, true);
});

Deno.test("no attempt id is a refusal, not a fresh Player", async () => {
  const { admin, rec } = makeAdmin();
  await assertRejects(
    () => resolvePlayerForCheckout(admin, {
      email: "a@b.com", name, owner: { academyProfileId: ACADEMY }, creationRequestId: "",
    }),
    Error,
    "missing_creation_request_id",
  );
  assertEquals(rec.rpc.length, 0, "it created a Player anyway");
});

Deno.test("a booking with no owner scope is refused before the constraint sees it", async () => {
  // `guest_players` requires a trainer or an academy, so this was always an opaque 500.
  const { admin, rec } = makeAdmin();
  await assertRejects(
    () => resolvePlayerForCheckout(admin, {
      email: "a@b.com", name, owner: {}, creationRequestId: REQ,
    }),
    Error,
    "no_owner_scope",
  );
  assertEquals(rec.rpc.length, 0);
});

Deno.test("a command that answers without a person is a refusal, not a fabricated id", async () => {
  const { admin } = makeAdmin({ player_create_command: { person_id: null } });
  await assertRejects(
    () => resolvePlayerForCheckout(admin, {
      email: "a@b.com", name, owner: { academyProfileId: ACADEMY }, creationRequestId: REQ,
    }),
    Error,
    "no_person",
  );
});

Deno.test("a refused command throws the CODE, never the message that may carry the address", async () => {
  const { admin } = makeAdmin({}, { code: "42501", message: "PLAYER_CREATE_FORBIDDEN for anna@example.com" });
  const err = await assertRejects(
    () => resolvePlayerForCheckout(admin, {
      email: "anna@example.com", name, owner: { academyProfileId: ACADEMY }, creationRequestId: REQ,
    }),
    Error,
  );
  assertEquals(err.message, "player_create_failed:42501");
  assertEquals(err.message.includes("anna@example.com"), false);
});

// ── the service-boundary adapter ────────────────────────────────────────────────────────────────

Deno.test("legacyBookingRef derives through the service-only adapter, person in", async () => {
  const { admin, rec } = makeAdmin({
    player_legacy_ref: { player_id: null, guest_player_id: "the-guest" },
  });
  const ref = await legacyBookingRef(admin, "the-person", { academyProfileId: ACADEMY });
  assertEquals(ref, { playerId: null, guestPlayerId: "the-guest" });
  assertEquals(rec.rpc[0].fn, "player_legacy_ref");
  assertEquals(rec.rpc[0].args._person_id, "the-person");
  assertEquals(rec.rpc[0].args._owner_type, "academy");
  assertEquals(rec.rpc[0].args._owner_id, ACADEMY);
  assertEquals(rec.tables, [], "the adapter call must not be accompanied by table reads");
});

Deno.test("an anonymous checkout takes the guest reference — and only inside this process", async () => {
  const { admin } = makeAdmin({
    player_legacy_ref: { player_id: null, guest_player_id: "the-guest" },
  });
  const guestId = await legacyGuestRefForCheckout(admin, "the-person", { academyProfileId: ACADEMY });
  assertEquals(guestId, "the-guest");
});

Deno.test("a person who CLAIMED their account after the attempt still replays — both sources, guest key answers", async () => {
  // The retry of a pre-claim checkout must not strand: the receipt replays to the surviving
  // person, and the in-scope guest row is still the compatible booking key. Visibility for the
  // account holder rides on bookings.person_id, not on which legacy column carried the row.
  const { admin } = makeAdmin({
    player_legacy_ref: { player_id: "their-profile", guest_player_id: "the-guest" },
  });
  const guestId = await legacyGuestRefForCheckout(admin, "the-person", { academyProfileId: ACADEMY });
  assertEquals(guestId, "the-guest");
});

Deno.test("a person with ONLY a profile source is the wrong person for the anonymous path — loud, not silent", async () => {
  // An account holder this flow never created books through the authenticated path; silently
  // writing them in as a guest is how a booking becomes untraceable to its origin.
  const { admin } = makeAdmin({
    player_legacy_ref: { player_id: "their-profile", guest_player_id: null },
  });
  await assertRejects(
    () => legacyGuestRefForCheckout(admin, "the-person", { academyProfileId: ACADEMY }),
    Error,
    "registered_player_path_required",
  );
});

Deno.test("no in-scope guest source is a broken invariant — loud, not a booking against nothing", async () => {
  const { admin } = makeAdmin({
    player_legacy_ref: { player_id: null, guest_player_id: null },
  });
  await assertRejects(
    () => legacyGuestRefForCheckout(admin, "the-person", { trainerId: TRAINER }),
    Error,
    "no_guest_source",
  );
});

Deno.test("an adapter refusal surfaces as its CODE — the derived id never leaks via errors either", async () => {
  const { admin } = makeAdmin({}, { code: "42501", message: "LEGACY_REF_SERVICE_ONLY" });
  const err = await assertRejects(
    () => legacyBookingRef(admin, "the-person", { trainerId: TRAINER }),
    Error,
  );
  assertEquals(err.message, "legacy_ref_failed:42501");
});
