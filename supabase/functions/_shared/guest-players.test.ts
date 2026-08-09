/**
 * The anonymous booking flows' guest identity.
 *
 * The tests this replaces asserted the family rule: a same-name row on the address was reused, a
 * sibling's was not, and a booking that omitted a phone number did not null out one captured
 * earlier. All of that described a lookup that decided WHO was booking from two attributes an
 * unauthenticated stranger had typed — the decision U2 removed. So what is asserted now is the
 * opposite: that no lookup happens, and that the create carries the booker's own attempt id.
 */
import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";
import { resolveOrCreateGuestPlayer } from "./guest-players.ts";

const ACADEMY = "11111111-1111-4111-8111-111111111111";
const TRAINER = "22222222-2222-4222-8222-222222222222";
const REQ = "33333333-3333-4333-8333-333333333333";

type Recorded = { rpc: Array<{ fn: string; args: Record<string, unknown> }>; tables: string[] };

function makeAdmin(
  result: unknown = { person_id: "the-person", guest_player_id: "the-guest" },
  error: { code: string; message: string } | null = null,
) {
  const rec: Recorded = { rpc: [], tables: [] };
  const admin = {
    from: (name: string) => {
      rec.tables.push(name);
      throw new Error("guest identity must not be resolved by querying tables");
    },
    rpc: (fn: string, args: Record<string, unknown>) => {
      rec.rpc.push({ fn, args });
      return Promise.resolve(error ? { data: null, error } : { data: result, error: null });
    },
  } as unknown as SupabaseClient;
  return { admin, rec };
}

const name = { first_name: "Anna", last_name: "de Vries", full_name: "Anna de Vries" };

Deno.test("a booking creates its Player through the command, carrying the attempt id", async () => {
  const { admin, rec } = makeAdmin();
  const out = await resolveOrCreateGuestPlayer(admin, {
    email: "Anna@Example.com",
    name,
    phone: "0612345678",
    owner: { academyProfileId: ACADEMY },
    source: "public_booking",
    creationRequestId: REQ,
  });

  assertEquals(out, { guestPlayerId: "the-guest", personId: "the-person" });
  assertEquals(rec.tables, [], "it queried a table");
  assertEquals(rec.rpc[0].fn, "player_create_command");
  assertEquals(rec.rpc[0].args._creation_request_id, REQ);
  assertEquals(rec.rpc[0].args._owner_type, "academy");
  assertEquals(rec.rpc[0].args._owner_id, ACADEMY);
  assertEquals(rec.rpc[0].args._email, "anna@example.com");
  assertEquals(rec.rpc[0].args._origin, "self_signup");
});

Deno.test("a trainer-owned slot books against the trainer scope", async () => {
  const { admin, rec } = makeAdmin();
  await resolveOrCreateGuestPlayer(admin, {
    email: "a@b.com", name, owner: { trainerId: TRAINER }, creationRequestId: REQ,
  });
  assertEquals(rec.rpc[0].args._owner_type, "trainer");
  assertEquals(rec.rpc[0].args._owner_id, TRAINER);
});

Deno.test("two bookers on ONE address are two creates — the address selects nobody", async () => {
  // The family case the old family rule existed for. It is no longer a rule about reuse: both
  // bookers create, each under their own attempt id, and the command proposes the duplicate.
  const parent = makeAdmin({ person_id: "p-parent", guest_player_id: "g-parent" });
  const child = makeAdmin({ person_id: "p-child", guest_player_id: "g-child" });

  const a = await resolveOrCreateGuestPlayer(parent.admin, {
    email: "family@example.com",
    name: { first_name: "Marieke", last_name: "de Vries", full_name: "Marieke de Vries" },
    owner: { academyProfileId: ACADEMY },
    creationRequestId: "44444444-4444-4444-8444-444444444444",
  });
  const b = await resolveOrCreateGuestPlayer(child.admin, {
    email: "family@example.com",
    name,
    owner: { academyProfileId: ACADEMY },
    creationRequestId: "55555555-5555-4555-8555-555555555555",
  });

  assertEquals(a.guestPlayerId !== b.guestPlayerId, true);
  assertEquals(parent.rec.rpc[0].args._creation_request_id !== child.rec.rpc[0].args._creation_request_id, true);
});

Deno.test("no attempt id is a refusal, not a fresh Player", async () => {
  const { admin, rec } = makeAdmin();
  await assertRejects(
    () => resolveOrCreateGuestPlayer(admin, {
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
    () => resolveOrCreateGuestPlayer(admin, {
      email: "a@b.com", name, owner: {}, creationRequestId: REQ,
    }),
    Error,
    "no_owner_scope",
  );
  assertEquals(rec.rpc.length, 0);
});

Deno.test("a refused command throws the CODE, never the message that may carry the address", async () => {
  const { admin } = makeAdmin(null, { code: "42501", message: "PLAYER_CREATE_FORBIDDEN for anna@example.com" });
  const err = await assertRejects(
    () => resolveOrCreateGuestPlayer(admin, {
      email: "anna@example.com", name, owner: { academyProfileId: ACADEMY }, creationRequestId: REQ,
    }),
    Error,
  );
  assertEquals(err.message, "guest_player_create_failed:42501");
  assertEquals(err.message.includes("anna@example.com"), false);
});
