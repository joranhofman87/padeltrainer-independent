/**
 * `create-manual-player` — the authorization gate and the create route, driven through the REAL
 * exported handler.
 *
 * The tests these replace grepped the source for `academy_create_player` and a role check. They
 * passed while an academy-only manager was refused at the gate and production never reached the RPC
 * at all — the finding that made this file necessary. A route test that cannot fail when the route
 * is disconnected is not a route test.
 *
 * Lives in `_shared/` because that is the directory `npm run test:edge` runs.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleRequest } from "../create-manual-player/index.ts";

const USER = "00000000-0000-4000-8000-00000000u5e1".replace(/u5e1/, "0001");
const ACADEMY = "11111111-1111-4111-8111-111111111111";
const OTHER_ACADEMY = "22222222-2222-4222-8222-222222222222";

interface Roles {
  clubManager?: boolean;
  trainer?: boolean;
  /** academies this user manages */
  manages?: string[];
  owns?: string[];
}

/** Records every RPC the handler makes, so a test can assert WHICH path ran. */
function makeClients(roles: Roles, rpcResult: unknown = { person_id: "p-1", guest_player_id: "g-1" }) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];

  const rpc = (fn: string, args: Record<string, unknown> = {}) => {
    calls.push({ fn, args });
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
      case "academy_create_player":
        return Promise.resolve({ data: rpcResult, error: null });
      default:
        return Promise.resolve({ data: null, error: null });
    }
  };

  const table = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "in", "order", "limit"]) chain[m] = () => chain;
    chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
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
  const adminClient = { rpc, from: table } as never;
  return { userClient, adminClient, calls };
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

const createCall = (calls: Array<{ fn: string }>) => calls.find((c) => c.fn === "academy_create_player");

Deno.test("an academy-only manager reaches the create RPC", async () => {
  // manages the academy; is neither a club manager nor a trainer — the role the old gate refused
  const { userClient, adminClient, calls } = makeClients({ manages: [ACADEMY] });
  const res = await handleRequest(req(academyBody()), { userClient, adminClient });

  assertEquals(res.status < 400, true, `expected success, got ${res.status}`);
  assertEquals(Boolean(createCall(calls)), true, "the academy create RPC was never called");
});

Deno.test("an academy OWNER reaches it too", async () => {
  const { userClient, adminClient, calls } = makeClients({ owns: [ACADEMY] });
  const res = await handleRequest(req(academyBody()), { userClient, adminClient });
  assertEquals(res.status < 400, true);
  assertEquals(Boolean(createCall(calls)), true);
});

Deno.test("a manager of a DIFFERENT academy is refused", async () => {
  const { userClient, adminClient, calls } = makeClients({ manages: [OTHER_ACADEMY] });
  const res = await handleRequest(req(academyBody()), { userClient, adminClient });

  assertEquals(res.status, 403);
  assertEquals(createCall(calls), undefined, "an unauthorized caller reached the create RPC");
});

Deno.test("club managers and trainers keep the access they had", async () => {
  for (const roles of [{ clubManager: true }, { trainer: true }]) {
    const { userClient, adminClient } = makeClients(roles);
    // no academy scope: the ordinary intake shape, which must still be admitted by the gate
    const res = await handleRequest(
      req({ email: "x@example.com", firstName: "A", lastName: "B", fullName: "A B" }),
      { userClient, adminClient },
    );
    assertEquals(`${JSON.stringify(roles)}:${res.status}`, `${JSON.stringify(roles)}:200`);
  }
});

Deno.test("the caller's request id is forwarded UNCHANGED to the command", async () => {
  const id = "44444444-4444-4444-8444-444444444444";
  const { userClient, adminClient, calls } = makeClients({ manages: [ACADEMY] });
  await handleRequest(req(academyBody({ creationRequestId: id })), { userClient, adminClient });

  assertEquals(createCall(calls)?.args._creation_request_id, id);
});

Deno.test("a retry carries the SAME request id, so the command can recognise it", async () => {
  const id = "55555555-5555-4555-8555-555555555555";
  const seen: unknown[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const { userClient, adminClient, calls } = makeClients({ manages: [ACADEMY] });
    await handleRequest(req(academyBody({ creationRequestId: id })), { userClient, adminClient });
    seen.push(createCall(calls)?.args._creation_request_id);
  }
  assertEquals(seen, [id, id]);
});

Deno.test("an academy create with NO request id is refused before anything is written", async () => {
  const { userClient, adminClient, calls } = makeClients({ manages: [ACADEMY] });
  const body = academyBody();
  delete (body as Record<string, unknown>).creationRequestId;
  const res = await handleRequest(req(body), { userClient, adminClient });

  assertEquals(res.status, 400);
  assertEquals(createCall(calls), undefined);
});

Deno.test("the canonical person_id comes back to the caller", async () => {
  const { userClient, adminClient } = makeClients(
    { manages: [ACADEMY] },
    { person_id: "the-person", guest_player_id: "the-guest" },
  );
  const res = await handleRequest(req(academyBody()), { userClient, adminClient });
  const body = await res.json();

  assertEquals(res.status < 400, true);
  // `person_id` is the identity; `guestPlayerId` remains only for readers that key on the source
  assertEquals(body.personId, "the-person");
  assertEquals(body.guestPlayerId, "the-guest");
});
