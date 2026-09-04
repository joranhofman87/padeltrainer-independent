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

// ── ABC-18 Pass B §1b: the four bridge arms are WITHDRAWN ───────────────────────────────────
// These were positives. Each granted one account access to a GUEST's invoice — its amounts,
// billing identity and payment page — on evidence the guest row or a mutable string supplied.
// They are inverted rather than deleted so the exact shapes stay covered.

Deno.test("twin-bridge guest invoice is now DENIED", async () => {
  const ok = await resolveInvoicePlayerAccess(
    { player_id: null, guest_player_id: "guest-1" },
    U,
    fakeClient({
      person_merge_review: null,
      profiles: { id: P },
      guest_players: { email: null, twin_of_profile_id: P, linked_profile_id: null },
      person_links: null,
    }),
  );
  assertEquals(ok, false);
});

Deno.test("linked-only bridge is now DENIED", async () => {
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
  assertEquals(linkedOnly, false);
});

Deno.test("shared person no longer grants access to a guest invoice", async () => {
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
  assertEquals(ok, false);
});

Deno.test("legacy email match no longer grants access", async () => {
  // A household address is ordinary; matching on it handed one person another's invoice.
  const ok = await resolveInvoicePlayerAccess(
    { player_id: null, guest_player_id: "guest-1" },
    U,
    fakeClient({
      person_merge_review: null,
      profiles: null,
      guest_players: { email: "ME@X.com", twin_of_profile_id: null, linked_profile_id: null },
      person_links: null,
    }),
  );
  assertEquals(ok, false);
});

Deno.test("DUAL-KEY invoice grants the accompanying account nothing", async () => {
  // The sharpest case: the invoice carries the caller's OWN profile id beside a guest. The
  // player arm used to match on player_id alone and hand it over.
  const ok = await resolveInvoicePlayerAccess(
    { player_id: P, guest_player_id: "guest-1" },
    U,
    fakeClient({
      person_merge_review: null,
      profiles: { user_id: "user-1", id: P },
      guest_players: { email: null, twin_of_profile_id: null, linked_profile_id: null },
      person_links: null,
    }),
  );
  assertEquals(ok, false);
});

Deno.test("PURE-PROFILE self is retained (direct auth id)", async () => {
  const ok = await resolveInvoicePlayerAccess(
    { player_id: "user-1", guest_player_id: null },
    U,
    fakeClient({ profiles: { user_id: "user-1" } }),
  );
  assertEquals(ok, true);
});

Deno.test("PURE-PROFILE self is retained (via profile lookup)", async () => {
  const ok = await resolveInvoicePlayerAccess(
    { player_id: P, guest_player_id: null },
    U,
    fakeClient({ profiles: { user_id: "user-1" } }),
  );
  assertEquals(ok, true);
});

Deno.test("fails CLOSED when the profile lookup errors", async () => {
  const erroring = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: function () { return this; },
          in: function () { return this; },
          limit: function () { return this; },
          single: () => Promise.resolve({ data: null, error: { message: "boom" } }),
          maybeSingle: () => Promise.resolve({ data: null, error: { message: "boom" } }),
        }),
      }),
    }),
  };
  const ok = await resolveInvoicePlayerAccess(
    { player_id: P, guest_player_id: null },
    U,
    erroring as unknown as Parameters<typeof resolveInvoicePlayerAccess>[2],
  );
  assertEquals(ok, false);
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
