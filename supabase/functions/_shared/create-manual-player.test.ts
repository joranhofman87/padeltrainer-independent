/**
 * `create-manual-player` — the authorization gate and the create route, driven through the REAL
 * exported handler.
 *
 * The tests these replace grepped the source for an RPC name and a role check. They passed while an
 * academy-only manager was refused at the gate and production never reached the RPC at all — the
 * finding that made this file necessary. A route test that cannot fail when the route is
 * disconnected is not a route test.
 *
 * Lives in `_shared/` because that is the directory `npm run test:edge` runs.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleRequest } from "../create-manual-player/index.ts";

const USER = "00000000-0000-4000-8000-000000000001";
const ACADEMY = "11111111-1111-4111-8111-111111111111";
const OTHER_ACADEMY = "22222222-2222-4222-8222-222222222222";

interface Roles {
  clubManager?: boolean;
  trainer?: boolean;
  /** academies this user manages */
  manages?: string[];
  owns?: string[];
  /** the caller owns the trainer_profiles row they are creating against */
  ownsTrainerProfile?: boolean;
}

type Recorded = {
  calls: Array<{ fn: string; args: Record<string, unknown> }>;
  tables: string[];
  emails: Array<Record<string, unknown>>;
};

/** Records every RPC, every table touched and every email, so a test can assert WHICH path ran. */
function makeClients(
  roles: Roles,
  rpcResult: unknown = { person_id: "p-1", guest_player_id: "g-1", created: true, replayed: false },
  rpcError: { code: string; message: string } | null = null,
) {
  const rec: Recorded = { calls: [], tables: [], emails: [] };

  const rpc = (fn: string, args: Record<string, unknown> = {}) => {
    rec.calls.push({ fn, args });
    switch (fn) {
      case "is_any_club_manager": return Promise.resolve({ data: !!roles.clubManager, error: null });
      case "is_trainer":          return Promise.resolve({ data: !!roles.trainer, error: null });
      case "is_academy_manager":
        return Promise.resolve({
          data: (roles.manages ?? []).includes(String(args._academy_profile_id)), error: null,
        });
      case "is_academy_owner":
        return Promise.resolve({
          data: (roles.owns ?? []).includes(String(args._academy_profile_id)), error: null,
        });
      case "player_create_command":
        return Promise.resolve(rpcError ? { data: null, error: rpcError } : { data: rpcResult, error: null });
      default:
        return Promise.resolve({ data: null, error: null });
    }
  };

  const table = (name: string) => {
    rec.tables.push(name);
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "in", "order", "limit"]) chain[m] = () => chain;
    chain.maybeSingle = () =>
      Promise.resolve({
        data: name === "trainer_profiles" && roles.ownsTrainerProfile ? { id: "tp-1" } : null,
        error: null,
      });
    chain.single = () => Promise.resolve({ data: { id: "row-1" }, error: null });
    chain.insert = () => ({
      select: () => ({ single: () => Promise.resolve({ data: { id: "row-1" }, error: null }) }),
    });
    chain.update = () => ({ eq: () => Promise.resolve({ error: null }) });
    chain.then = (res: (v: { data: unknown; error: null }) => unknown) =>
      Promise.resolve(res({ data: [], error: null }));
    return chain;
  };

  const userClient = {
    auth: { getClaims: () => Promise.resolve({ data: { claims: { sub: USER } }, error: null }) },
    rpc,
    from: table,
  } as never;
  const adminClient = {
    rpc,
    from: table,
    functions: {
      invoke: (_fn: string, opts: { body: Record<string, unknown> }) => {
        rec.emails.push(opts.body);
        return Promise.resolve({ data: null, error: null });
      },
    },
  } as never;
  return { userClient, adminClient, rec };
}

const req = (body: Record<string, unknown>) =>
  new Request("http://localhost/create-manual-player", {
    method: "POST",
    headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const academyBody = (over: Record<string, unknown> = {}) => ({
  email: "speler@example.com",
  firstName: "Nieuwe",
  lastName: "Speler",
  fullName: "Nieuwe Speler",
  academyProfileId: ACADEMY,
  creationRequestId: "33333333-3333-4333-8333-333333333333",
  ...over,
});

const createCall = (rec: Recorded) => rec.calls.find((c) => c.fn === "player_create_command");

Deno.test("an academy-only manager reaches the create command", async () => {
  // manages the academy; is neither a club manager nor a trainer — the role the old gate refused
  const { userClient, adminClient, rec } = makeClients({ manages: [ACADEMY] });
  const res = await handleRequest(req(academyBody()), { userClient, adminClient });

  assertEquals(res.status < 400, true, `expected success, got ${res.status}`);
  assertEquals(Boolean(createCall(rec)), true, "the create command was never called");
});

Deno.test("an academy OWNER reaches it too", async () => {
  const { userClient, adminClient, rec } = makeClients({ owns: [ACADEMY] });
  const res = await handleRequest(req(academyBody()), { userClient, adminClient });
  assertEquals(res.status < 400, true);
  assertEquals(Boolean(createCall(rec)), true);
});

Deno.test("a manager of a DIFFERENT academy is refused", async () => {
  const { userClient, adminClient, rec } = makeClients({ manages: [OTHER_ACADEMY] });
  const res = await handleRequest(req(academyBody()), { userClient, adminClient });

  assertEquals(res.status, 403);
  assertEquals(createCall(rec), undefined, "an unauthorized caller reached the create command");
});

Deno.test("a trainer creating in their own practice reaches the command", async () => {
  const trainer = "77777777-7777-4777-8777-777777777777";
  const { userClient, adminClient, rec } = makeClients({ trainer: true, ownsTrainerProfile: true });
  // the admin client answers the trainer-ownership lookup with a row, i.e. this is their practice
  const res = await handleRequest(
    req({
      email: "x@example.com",
      firstName: "A",
      lastName: "B",
      fullName: "A B",
      trainerProfileId: trainer,
      creationRequestId: "44444444-4444-4444-8444-444444444401",
    }),
    { userClient, adminClient },
  );
  assertEquals(res.status, 200, await res.clone().text());
  assertEquals(createCall(rec)?.args._owner_type, "trainer");
  assertEquals(createCall(rec)?.args._owner_id, trainer);
});

Deno.test("a create naming NEITHER an academy nor a trainer is refused, with the reason", async () => {
  // `guest_players` has required one or the other since 2026-02, so this shape never worked — it
  // reached the insert and came back as an opaque 500. Refusing it here is the honest version.
  for (const roles of [{ clubManager: true }, { trainer: true }]) {
    const { userClient, adminClient, rec } = makeClients(roles);
    const res = await handleRequest(
      req({
        email: "x@example.com",
        firstName: "A",
        lastName: "B",
        fullName: "A B",
        creationRequestId: "44444444-4444-4444-8444-444444444402",
      }),
      { userClient, adminClient },
    );
    const body = await res.json();
    assertEquals(`${JSON.stringify(roles)}:${res.status}`, `${JSON.stringify(roles)}:400`);
    assertEquals(body.code, "PLAYER_CREATE_BAD_SCOPE");
    assertEquals(createCall(rec), undefined);
  }
});

Deno.test("the caller's request id is forwarded UNCHANGED to the command", async () => {
  const id = "44444444-4444-4444-8444-444444444444";
  const { userClient, adminClient, rec } = makeClients({ manages: [ACADEMY] });
  await handleRequest(req(academyBody({ creationRequestId: id })), { userClient, adminClient });

  assertEquals(createCall(rec)?.args._creation_request_id, id);
});

Deno.test("a retry carries the SAME request id, so the command can recognise it", async () => {
  const id = "55555555-5555-4555-8555-555555555555";
  const seen: unknown[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const { userClient, adminClient, rec } = makeClients({ manages: [ACADEMY] });
    await handleRequest(req(academyBody({ creationRequestId: id })), { userClient, adminClient });
    seen.push(createCall(rec)?.args._creation_request_id);
  }
  assertEquals(seen, [id, id]);
});

Deno.test("a create with NO request id is refused before anything is written — in EVERY scope", async () => {
  const scopes: Array<Record<string, unknown>> = [
    { academyProfileId: ACADEMY },
    { trainerProfileId: "77777777-7777-4777-8777-777777777777" },
  ];
  for (const scope of scopes) {
    const { userClient, adminClient, rec } = makeClients({
      manages: [ACADEMY], trainer: true, ownsTrainerProfile: true,
    });
    const body = { ...academyBody(), ...scope } as Record<string, unknown>;
    if (!("academyProfileId" in scope)) delete body.academyProfileId;
    delete body.creationRequestId;
    const res = await handleRequest(req(body), { userClient, adminClient });

    assertEquals(res.status, 400, `scope ${JSON.stringify(scope)} was not refused`);
    assertEquals(createCall(rec), undefined);
  }
});

Deno.test("the canonical person_id comes back to the caller", async () => {
  const { userClient, adminClient } = makeClients(
    { manages: [ACADEMY] },
    { person_id: "the-person", guest_player_id: "the-guest", created: true, replayed: false },
  );
  const res = await handleRequest(req(academyBody()), { userClient, adminClient });
  const body = await res.json();

  assertEquals(res.status < 400, true);
  // `person_id` is the identity; `guestPlayerId` remains only for readers that key on the source row
  assertEquals(body.personId, "the-person");
  assertEquals(body.guestPlayerId, "the-guest");
  // and NOT a profile: this handler no longer resolves accounts, so it cannot answer with one
  assertEquals(body.profileId, undefined);
});

// ── the bypass this checkpoint existed to remove ────────────────────────────────────────────────
Deno.test("the handler never looks a person up — no profiles read, no guest_players read", async () => {
  const { userClient, adminClient, rec } = makeClients({ manages: [ACADEMY] });
  await handleRequest(req(academyBody()), { userClient, adminClient });

  assertEquals(rec.tables.includes("profiles"), false, "it read profiles");
  assertEquals(rec.tables.includes("guest_players"), false, "it read guest_players");
});

Deno.test("an existing account holder's own address does NOT divert the create", async () => {
  // Whatever else is true of this address, the answer is the command's. There is no branch left
  // that could return a profile id instead, which is what the assertion on `_select_person_id`
  // pins: nothing but an explicit caller-supplied id can name an existing Player.
  const { userClient, adminClient, rec } = makeClients({ manages: [ACADEMY] });
  const res = await handleRequest(
    req(academyBody({ email: "known@example.com", fullName: "Known Person" })),
    { userClient, adminClient },
  );
  assertEquals(res.status < 400, true);
  assertEquals(createCall(rec)?.args._select_person_id, null);
});

Deno.test("an explicitly named existing Player is forwarded for the database to authorize", async () => {
  const person = "66666666-6666-4666-8666-666666666666";
  const { userClient, adminClient, rec } = makeClients({ manages: [ACADEMY] });
  await handleRequest(req(academyBody({ selectPersonId: person })), { userClient, adminClient });

  assertEquals(createCall(rec)?.args._select_person_id, person);
});

// ── a Player with no email ──────────────────────────────────────────────────────────────────────
Deno.test("a Player with NO email is created, and no confirmation is attempted", async () => {
  const { userClient, adminClient, rec } = makeClients({ manages: [ACADEMY] });
  const body = academyBody();
  delete (body as Record<string, unknown>).email;
  const res = await handleRequest(req(body), { userClient, adminClient });

  assertEquals(res.status < 400, true, `expected success, got ${res.status}`);
  assertEquals(createCall(rec)?.args._email, null);
  assertEquals(rec.emails.length, 0, "it tried to email a player with no address");
});

Deno.test("...and one WITH an email still gets the confirmation", async () => {
  const { userClient, adminClient, rec } = makeClients({ manages: [ACADEMY] });
  await handleRequest(req(academyBody()), { userClient, adminClient });

  assertEquals(rec.emails.length, 1);
  assertEquals(rec.emails[0].to, "speler@example.com");
});

Deno.test("a create with neither a name nor a named Player is refused", async () => {
  const { userClient, adminClient, rec } = makeClients({ manages: [ACADEMY] });
  const body = academyBody();
  for (const k of ["firstName", "lastName", "fullName"]) delete (body as Record<string, unknown>)[k];
  const res = await handleRequest(req(body), { userClient, adminClient });

  assertEquals(res.status, 400);
  assertEquals(createCall(rec), undefined);
});

Deno.test("both an academy and a trainer is refused rather than silently attached to one", async () => {
  const { userClient, adminClient, rec } = makeClients({ manages: [ACADEMY] });
  const res = await handleRequest(
    req(academyBody({ trainerProfileId: "77777777-7777-4777-8777-777777777777" })),
    { userClient, adminClient },
  );
  assertEquals(res.status, 400);
  assertEquals(createCall(rec), undefined);
});

// ── the command's refusals reach the caller as themselves ───────────────────────────────────────
Deno.test("the command's SQLSTATE picks the status, and its code travels", async () => {
  const cases: Array<[string, string, number]> = [
    ["42501", "PLAYER_CREATE_PERSON_NOT_YOURS: that Player is not one this scope can select", 403],
    ["22023", "PLAYER_CREATE_BAD_SCOPE: an owned scope needs an owner id", 400],
    ["23505", "PLAYER_CREATE_IDEMPOTENCY_CONFLICT: request x was already used", 409],
    ["XX000", "PLAYER_CREATE_RESULT_GONE: the Player request x created no longer exists", 500],
  ];
  for (const [code, message, status] of cases) {
    const { userClient, adminClient } = makeClients({ manages: [ACADEMY] }, undefined, { code, message });
    const res = await handleRequest(req(academyBody()), { userClient, adminClient });
    const body = await res.json();
    assertEquals(`${code}:${res.status}`, `${code}:${status}`);
    assertEquals(body.code, message.split(":")[0]);
  }
});
