/**
 * `submit-guest-intake` — who a public registration is attributed to, driven through the REAL
 * exported handler.
 *
 * This endpoint used to answer that by looking the submitted address up in `profiles` and, if a row
 * came back whose name agreed, attributing the registration — and the invoice minted from it — to
 * that account. Then it did the same against `guest_players`, reusing the matched row and
 * OVERWRITING its details with whatever an anonymous stranger had just typed. Two mutable
 * attributes, from an unauthenticated form, selecting an existing human.
 *
 * The assertions are about behaviour, not about the source: what the handler READS (nothing about
 * people) and what it SENDS to the create command.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleRequest } from "../submit-guest-intake/index.ts";

const ACADEMY = "11111111-1111-4111-8111-111111111111";
const TRAINER = "22222222-2222-4222-8222-222222222222";
const CLUB = "33333333-3333-4333-8333-333333333333";
const REG = "44444444-4444-4444-8444-444444444444";

type Recorded = {
  calls: Array<{ fn: string; args: Record<string, unknown> }>;
  tables: string[];
  intakeInserts: Array<Record<string, unknown>>;
};

// The identity resolver's answer, overridable per test (default: first-timer proceeds as new).
let identityResolution: Record<string, unknown> = { status: "proceed_new" };

function makeAdmin(ownerType: "academy" | "trainer" | "club") {
  const rec: Recorded = { calls: [], tables: [], intakeInserts: [] };
  const ownerId = ownerType === "academy" ? ACADEMY : ownerType === "trainer" ? TRAINER : CLUB;

  const registration = {
    id: REG,
    source_cycle_id: null,
    owner_type: ownerType,
    owner_id: ownerId,
    // no payment_methods in settings ⇒ resolveEffectivePaymentMethod returns null ⇒ no invoice mint
    format: "registration",
    status: "open",
    name: "Najaar",
    total_price: null,
    price_table: null,
    currency: null,
    settings: {},
    start_date: null,
    end_date: null,
    location_id: null,
  };

  const from = (name: string) => {
    rec.tables.push(name);
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "in", "order", "limit", "gte", "lte"]) chain[m] = () => chain;
    chain.maybeSingle = () =>
      Promise.resolve({ data: name === "registrations" ? registration : null, error: null });
    chain.single = () => Promise.resolve({ data: { id: "row-1" }, error: null });
    chain.insert = (row: Record<string, unknown>) => {
      if (name === "intake_requests") rec.intakeInserts.push(row);
      return {
        select: () => ({ single: () => Promise.resolve({ data: { id: "intake-1", ...row }, error: null }) }),
      };
    };
    chain.upsert = () => Promise.resolve({ error: null });
    chain.update = () => ({ eq: () => Promise.resolve({ error: null }) });
    // the duplicate-window and IP counts read `count`, never rows
    chain.then = (res: (v: { data: unknown; error: null; count: number }) => unknown) =>
      Promise.resolve(res({ data: [], error: null, count: 0 }));
    return chain;
  };

  const adminClient = {
    from,
    rpc: (fn: string, args: Record<string, unknown> = {}) => {
      rec.calls.push({ fn, args });
      // U2 identity continuity: the resolver runs before any create. Default = first-timer proceeds
      // as new; tests override `identityResolution` to exercise verify_required / proceed_person.
      if (fn === "identity_resolve_or_challenge") {
        return Promise.resolve({ data: identityResolution, error: null });
      }
      // Per-function answers, matching the real contracts: the create command is canonical-only,
      // and the legacy reference exists ONLY in the service adapter's answer.
      if (fn === "player_create_command") {
        return Promise.resolve({
          data: { person_id: "the-person", created: true, replayed: false },
          error: null,
        });
      }
      if (fn === "player_legacy_ref") {
        return Promise.resolve({
          data: { player_id: null, guest_player_id: "the-guest" },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    },
    functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
  } as never;

  return { adminClient, rec };
}

const body = (over: Record<string, unknown> = {}) => ({
  email: "Speler@Example.com",
  firstName: "Nieuwe",
  lastName: "Speler",
  phone: "0612345678",
  cycleId: REG,
  lessonTypes: ["group"],
  preferredDays: ["mon"],
  preferredTimeWindows: [],
  consentGiven: true,
  creationRequestId: "55555555-5555-4555-8555-555555555555",
  ...over,
});

const req = (payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
  new Request("http://localhost/submit-guest-intake", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });

const createCall = (rec: Recorded) => rec.calls.find((c) => c.fn === "player_create_command");

Deno.test("a public submission creates its Player through the UUID command", async () => {
  const { adminClient, rec } = makeAdmin("academy");
  const res = await handleRequest(req(body()), { adminClient });

  assertEquals(res.status, 200, await res.clone().text());
  const call = createCall(rec);
  assertEquals(Boolean(call), true, "the create command was never called");
  assertEquals(call?.args._origin, "self_signup");
  assertEquals(call?.args._actor_user_id, null);
  assertEquals(call?.args._select_person_id, null);
  assertEquals(call?.args._creation_request_id, "55555555-5555-4555-8555-555555555555");
});

Deno.test("it reads nothing about people — no profiles, no guest_players", async () => {
  const { adminClient, rec } = makeAdmin("academy");
  await handleRequest(req(body()), { adminClient });

  assertEquals(rec.tables.includes("profiles"), false, "it read profiles");
  assertEquals(rec.tables.includes("guest_players"), false, "it read guest_players");
});

Deno.test("the intake row carries the created Player and never an account", async () => {
  const { adminClient, rec } = makeAdmin("academy");
  await handleRequest(req(body()), { adminClient });

  assertEquals(rec.intakeInserts.length, 1);
  assertEquals(rec.intakeInserts[0].guest_player_id, "the-guest");
  assertEquals(rec.intakeInserts[0].player_id, null);
});

Deno.test("the legacy column is DERIVED from the person by the service adapter — not returned by the create", async () => {
  // The command answers canonically; the guest id the intake row still physically needs comes from
  // `player_legacy_ref`, called with the person and the FORM's owner scope, and dies in this
  // process (owner correction, 2026-08-09).
  const { adminClient, rec } = makeAdmin("academy");
  await handleRequest(req(body()), { adminClient });

  const refCall = rec.calls.find((c) => c.fn === "player_legacy_ref");
  assertEquals(Boolean(refCall), true, "the adapter was never asked");
  assertEquals(refCall?.args._person_id, "the-person");
  assertEquals(refCall?.args._owner_type, "academy");
  assertEquals(refCall?.args._owner_id, ACADEMY);
});

Deno.test("the HTTP response carries no legacy id — the derived reference dies inside the function", async () => {
  const { adminClient } = makeAdmin("academy");
  const res = await handleRequest(req(body()), { adminClient });
  const text = await res.text();

  assertEquals(res.status, 200);
  assertEquals(text.includes("the-guest"), false, "the derived guest id leaked into the response");
  assertEquals(/guest_?player_?id/i.test(text), false, "the response names a legacy id field");
});

Deno.test("a signed-in submitter's token does not divert the attribution", async () => {
  // The form routes a person registering THEMSELF down a different path entirely; what reaches here
  // while signed in is a parent filling the form in for a child. Attributing that submission to the
  // submitter's own account would be the same bug in a new costume — so the token is not consulted,
  // and the outcome is identical with and without one.
  const anon = makeAdmin("academy");
  const signedIn = makeAdmin("academy");

  const a = await handleRequest(req(body()), { adminClient: anon.adminClient });
  const b = await handleRequest(
    req(body(), { Authorization: "Bearer a.real-looking.user-token" }),
    { adminClient: signedIn.adminClient },
  );

  assertEquals([a.status, b.status], [200, 200]);
  assertEquals(signedIn.rec.intakeInserts[0].player_id, null);
  assertEquals(signedIn.rec.intakeInserts[0].guest_player_id, "the-guest");
  assertEquals(createCall(signedIn.rec)?.args._actor_user_id, null);
  // and the token did not make it read anybody up either
  assertEquals(signedIn.rec.tables.includes("profiles"), false);
  assertEquals(
    JSON.stringify(createCall(anon.rec)?.args),
    JSON.stringify(createCall(signedIn.rec)?.args),
  );
});

Deno.test("the owner comes from the REGISTRATION, not from the submission", async () => {
  for (const [ownerType, expectedId] of [["academy", ACADEMY], ["trainer", TRAINER]] as const) {
    const { adminClient, rec } = makeAdmin(ownerType);
    await handleRequest(req(body()), { adminClient });
    assertEquals(createCall(rec)?.args._owner_type, ownerType);
    assertEquals(createCall(rec)?.args._owner_id, expectedId);
  }
});

Deno.test("a CLUB-owned form is refused legibly instead of failing at the constraint", async () => {
  // `guest_players` requires a trainer or an academy and has no club column, so this endpoint has
  // never been able to record a club-owned sign-up: it inserted, violated the CHECK, and answered
  // with a generic 500. Pre-existing, and now named rather than hidden.
  const { adminClient, rec } = makeAdmin("club");
  const res = await handleRequest(req(body()), { adminClient });
  const parsed = await res.json();

  assertEquals(res.status, 400);
  assertEquals(parsed.error, "registration_unsupported");
  assertEquals(createCall(rec), undefined, "it tried to create a Player it cannot own");
  assertEquals(rec.intakeInserts.length, 0, "it wrote an intake row for a Player that was never made");
});

Deno.test("a submission with no attempt id is refused, not given a fresh one", async () => {
  // Minting one here would make every retry a NEW attempt: the first request creates the Player,
  // its response is lost, and the resubmission creates a second one.
  for (const bad of [undefined, "", "not-a-uuid", 12345]) {
    const { adminClient, rec } = makeAdmin("academy");
    const payload = body();
    if (bad === undefined) delete (payload as Record<string, unknown>).creationRequestId;
    else (payload as Record<string, unknown>).creationRequestId = bad;
    const res = await handleRequest(req(payload), { adminClient });

    const parsed = await res.json();
    assertEquals(`${String(bad)}:${res.status}`, `${String(bad)}:400`);
    // ...and it says what fixes it: a page cached from before this shipped sends no id, and the
    // registrant did nothing wrong.
    assertEquals(parsed.error, "stale_client");
    assertEquals(createCall(rec), undefined, `it created a Player for ${String(bad)}`);
  }
});

Deno.test("a retry carrying the same attempt id is the same create", async () => {
  const seen: unknown[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const { adminClient, rec } = makeAdmin("academy");
    await handleRequest(req(body()), { adminClient });
    seen.push(createCall(rec)?.args._creation_request_id);
  }
  assertEquals(seen, ["55555555-5555-4555-8555-555555555555", "55555555-5555-4555-8555-555555555555"]);
});

Deno.test("the address is normalized once, on the way in", async () => {
  const { adminClient, rec } = makeAdmin("academy");
  await handleRequest(req(body({ email: "MiXeD@Example.COM" })), { adminClient });
  assertEquals(createCall(rec)?.args._email, "mixed@example.com");
});

// ── U2 identity continuity ──────────────────────────────────────────────────────────────────────

Deno.test("a candidate collision returns verification_required with NO Player, intake or leak", async () => {
  identityResolution = { status: "verify_required" };
  try {
    const { adminClient, rec } = makeAdmin("academy");
    const res = await handleRequest(req(body()), { adminClient });
    const parsed = await res.json();
    assertEquals(res.status, 200);
    assertEquals(parsed.status, "verification_required");
    // NOTHING created or written, and no candidate identity/name/count in the response
    assertEquals(createCall(rec), undefined, "it created a Player before verification");
    assertEquals(rec.intakeInserts.length, 0, "it wrote an intake row before verification");
    assertEquals(Object.keys(parsed), ["status"]);
  } finally {
    identityResolution = { status: "proceed_new" };
  }
});

Deno.test("a verified returning Player skips the create and uses their canonical person", async () => {
  identityResolution = { status: "proceed_person", person_id: "the-returning-person" };
  try {
    const { adminClient, rec } = makeAdmin("academy");
    const res = await handleRequest(req(body()), { adminClient });
    assertEquals(res.status, 200);
    assertEquals(createCall(rec), undefined, "it created a Player instead of reusing the chosen one");
    // the legacy ref for the intake row is derived from the CHOSEN person, not a fresh create
    const refCall = rec.calls.find((c) => c.fn === "player_legacy_ref");
    assertEquals(refCall?.args._person_id, "the-returning-person");
    assertEquals(rec.intakeInserts.length, 1);
    assertEquals(rec.intakeInserts[0].guest_player_id, "the-guest");
  } finally {
    identityResolution = { status: "proceed_new" };
  }
});
