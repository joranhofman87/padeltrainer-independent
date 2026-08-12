/**
 * verify-identity edge handler — the link target. Proves the edge NEVER narrates why a token
 * failed (enumeration oracle), maps key-unavailable to a retryable 503, binds the signed generation
 * to the stored row, and passes the RPC's own outcomes through unchanged. The token crypto itself is
 * proven in identity-verify-token.test.ts; here the token module runs for real against test keys.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";
import { handleRequest } from "../verify-identity/index.ts";
import { buildIdentityToken } from "./identity-verify-token.ts";

const CH = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
Deno.env.set("IDENTITY_VERIFY_TOKEN_KEY_V1", "a".repeat(64));

type Stub = {
  keyState?: { current_version: number; min_mintable_version: number } | null;
  row?: { key_version: number } | null;
  rowError?: boolean;
  listResult?: unknown;
  selectResult?: unknown;
  rpcError?: boolean;
};

function makeAdmin(stub: Stub) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const admin = {
    // only the key-state read is a direct table SELECT (that table IS granted to service_role);
    // the challenge row lookup goes through the definer RPC below (Codex r1 f1).
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => {
            if (table === "identity_verify_key_state") {
              return Promise.resolve({ data: stub.keyState === undefined ? { current_version: 1, min_mintable_version: 1 } : stub.keyState, error: null });
            }
            return Promise.resolve({ data: null, error: null });
          },
        }),
      }),
    }),
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === "identity_challenge_key_version") {
        if (stub.rowError) return Promise.resolve({ data: null, error: { message: "boom" } });
        const row = stub.row === undefined ? { key_version: 1 } : stub.row;
        return Promise.resolve({ data: row === null ? null : (row as { key_version: number }).key_version, error: null });
      }
      if (stub.rpcError) return Promise.resolve({ data: null, error: { message: "db" } });
      if (fn === "identity_verification_list") return Promise.resolve({ data: stub.listResult ?? { status: "ok", candidates: [] }, error: null });
      if (fn === "identity_verification_select") return Promise.resolve({ data: stub.selectResult ?? { status: "ok" }, error: null });
      return Promise.resolve({ data: null, error: null });
    },
  } as unknown as SupabaseClient;
  return { admin, calls };
}

const req = (body: unknown) =>
  new Request("http://localhost/verify-identity", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

async function goodToken(): Promise<string> {
  return await buildIdentityToken(CH, 1, { currentVersion: 1, minMintableVersion: 1 });
}

Deno.test("a forged/garbage token gets the uniform generic answer, never a reason", async () => {
  const { admin, calls } = makeAdmin({});
  const res = await handleRequest(req({ token: "not-a-token", action: "list" }), { adminClient: admin });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { status: "invalid" });
  assertEquals(calls.length, 0, "a forged token must not reach any RPC");
});

Deno.test("a missing key state is a retryable 503, never a silent invalid", async () => {
  const { admin } = makeAdmin({ keyState: null });
  const res = await handleRequest(req({ token: await goodToken(), action: "list" }), { adminClient: admin });
  assertEquals(res.status, 503);
});

Deno.test("a valid token lists candidates via the RPC (post-verification disclosure)", async () => {
  const { admin, calls } = makeAdmin({ listResult: { status: "ok", candidates: [{ person_id: "p1", name: "A" }] } });
  const res = await handleRequest(req({ token: await goodToken(), action: "list" }), { adminClient: admin });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { status: "ok", candidates: [{ person_id: "p1", name: "A" }] });
  const listCall = calls.find((c) => c.fn === "identity_verification_list");
  assertEquals(listCall?.args._challenge_id, CH);
});

Deno.test("a generation mismatch between token and row collapses to the uniform answer", async () => {
  const { admin, calls } = makeAdmin({ row: { key_version: 2 } });  // token signed under v1
  const res = await handleRequest(req({ token: await goodToken(), action: "list" }), { adminClient: admin });
  assertEquals(await res.json(), { status: "invalid" });
  // the key_version lookup runs (that IS the binding check); no list/select may follow it
  assertEquals(calls.some((c) => c.fn === "identity_verification_list" || c.fn === "identity_verification_select"), false,
    "a mismatched generation must not reach list/select");
});

Deno.test("a row-lookup fault is retryable (503), not a fabricated invalid", async () => {
  const { admin } = makeAdmin({ rowError: true });
  const res = await handleRequest(req({ token: await goodToken(), action: "list" }), { adminClient: admin });
  assertEquals(res.status, 503);
});

Deno.test("select passes the choice through and returns the canonical answer", async () => {
  const { admin, calls } = makeAdmin({ selectResult: { status: "ok", person_id: "p9" } });
  const res = await handleRequest(
    req({ token: await goodToken(), action: "select", person_id: "99999999-1111-4111-8111-111111111111" }),
    { adminClient: admin },
  );
  assertEquals(await res.json(), { status: "ok", person_id: "p9" });
  const selCall = calls.find((c) => c.fn === "identity_verification_select");
  assertEquals(selCall?.args._choose_someone_new, false);
});

Deno.test("select 'someone new' needs no person id", async () => {
  const { admin, calls } = makeAdmin({ selectResult: { status: "ok", someone_new: true } });
  const res = await handleRequest(
    req({ token: await goodToken(), action: "select", choose_someone_new: true }),
    { adminClient: admin },
  );
  assertEquals((await res.json()).someone_new, true);
  const newCall = calls.find((c) => c.fn === "identity_verification_select");
  assertEquals(newCall?.args._choose_someone_new, true);
  assertEquals(newCall?.args._person_id, null);
});

Deno.test("select without a candidate or someone-new is refused before the RPC", async () => {
  const { admin, calls } = makeAdmin({});
  const res = await handleRequest(req({ token: await goodToken(), action: "select" }), { adminClient: admin });
  assertEquals(await res.json(), { status: "not_a_candidate" });
  assertEquals(calls.some((c) => c.fn === "identity_verification_select"), false);
});

Deno.test("an RPC fault is retryable (503), never echoed", async () => {
  const { admin } = makeAdmin({ rpcError: true });
  const res = await handleRequest(req({ token: await goodToken(), action: "list" }), { adminClient: admin });
  assertEquals(res.status, 503);
});
