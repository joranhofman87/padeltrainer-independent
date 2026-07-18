import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { resolveInvoicePlayerAccess, type AuthzClient } from "./invoice-player-authz.ts";

// Scripted fake of the service-role client: table → row (or 'ERROR' to simulate
// a failed lookup). The filter chain records nothing — each table resolves to a
// single canned result, which is all the helper's lookups need.
function fakeClient(rows: Record<string, Record<string, unknown> | null | "ERROR">): AuthzClient {
  const resolve = (table: string) => {
    const row = rows[table];
    if (row === "ERROR") return Promise.resolve({ data: null, error: { message: "boom" } });
    return Promise.resolve({ data: row ?? null, error: null });
  };
  const filter = (table: string) => ({
    eq: () => filter(table),
    in: () => filter(table),
    limit: () => filter(table),
    single: () => resolve(table),
    maybeSingle: () => resolve(table),
  });
  return {
    from: (table: string) => ({ select: () => ({ eq: () => filter(table) }) }),
  } as unknown as AuthzClient;
}

const U = { id: "user-1", email: "me@x.com" };
const P = "profile-1";

Deno.test("pure-profile invoice: player arm allows via profiles lookup", async () => {
  const ok = await resolveInvoicePlayerAccess(
    { player_id: P, guest_player_id: null },
    U,
    fakeClient({ profiles: { user_id: "user-1" } }),
  );
  assertEquals(ok, true);
});

Deno.test("REGRESSION (adversarial P1): frozen both-keyed invoice — the PLAYER arm is suppressed too", async () => {
  const ok = await resolveInvoicePlayerAccess(
    { player_id: P, guest_player_id: "guest-1" },
    U,
    fakeClient({
      person_merge_review: { id: "review-1" }, // pending freeze row
      profiles: { user_id: "user-1" },         // player arm WOULD match
    }),
  );
  assertEquals(ok, false); // freeze outside the arms
});

Deno.test("REGRESSION (adversarial P2): freeze lookup error fails CLOSED", async () => {
  const ok = await resolveInvoicePlayerAccess(
    { player_id: P, guest_player_id: "guest-1" },
    U,
    fakeClient({
      person_merge_review: "ERROR",
      profiles: { user_id: "user-1" },
    }),
  );
  assertEquals(ok, false);
});

Deno.test("REGRESSION (adversarial P2): twin-bridge guest invoice allows (listed rows must download)", async () => {
  const ok = await resolveInvoicePlayerAccess(
    { player_id: null, guest_player_id: "guest-1" },
    U,
    fakeClient({
      person_merge_review: null,
      profiles: { id: P },
      guest_players: { email: null, twin_of_profile_id: P, linked_profile_id: null },
      person_links: null, // no person rows — bridge must carry it
    }),
  );
  assertEquals(ok, true);
});

Deno.test("linked-only bridge (no twin stamp) allows; twin stamp to ANOTHER profile blocks the linked path", async () => {
  const linkedOnly = await resolveInvoicePlayerAccess(
    { player_id: null, guest_player_id: "guest-1" },
    U,
    fakeClient({
      person_merge_review: null,
      profiles: { id: P },
      guest_players: { email: null, twin_of_profile_id: null, linked_profile_id: P },
      person_links: null,
    }),
  );
  assertEquals(linkedOnly, true);
  const twinElsewhere = await resolveInvoicePlayerAccess(
    { player_id: null, guest_player_id: "guest-1" },
    U,
    fakeClient({
      person_merge_review: null,
      profiles: { id: P },
      guest_players: { email: null, twin_of_profile_id: "profile-OTHER", linked_profile_id: P },
      person_links: null,
    }),
  );
  assertEquals(twinElsewhere, false); // twin-precedence: linked ignored when twin points elsewhere
});

Deno.test("person arm allows when guest and caller profile share a person", async () => {
  // person_links is queried twice (guest link, then profile link) — same canned
  // row serves both, so equal person ids → allow.
  const ok = await resolveInvoicePlayerAccess(
    { player_id: null, guest_player_id: "guest-1" },
    U,
    fakeClient({
      person_merge_review: null,
      profiles: { id: P },
      person_links: { person_id: "person-X" },
      guest_players: { email: null, twin_of_profile_id: null, linked_profile_id: null },
    }),
  );
  assertEquals(ok, true);
});

Deno.test("legacy email fallback allows (deliberate exception, case-insensitive)", async () => {
  const ok = await resolveInvoicePlayerAccess(
    { player_id: null, guest_player_id: "guest-1" },
    U,
    fakeClient({
      person_merge_review: null,
      profiles: null, // caller has no profile at all
      guest_players: { email: "ME@X.com", twin_of_profile_id: null, linked_profile_id: null },
      person_links: null,
    }),
  );
  assertEquals(ok, true);
});

Deno.test("unrelated caller is denied", async () => {
  const ok = await resolveInvoicePlayerAccess(
    { player_id: "someone-else", guest_player_id: "guest-1" },
    U,
    fakeClient({
      person_merge_review: null,
      profiles: { user_id: "other-user", id: P },
      guest_players: { email: "other@x.com", twin_of_profile_id: null, linked_profile_id: "profile-OTHER" },
      person_links: null,
    }),
  );
  assertEquals(ok, false);
});
