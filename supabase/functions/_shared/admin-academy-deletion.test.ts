/**
 * `admin-academy-deletion` — the audit lifecycle at the transport boundary.
 *
 * Lives in `_shared/` because that is the directory `npm run test:edge` runs; it imports the real
 * handler from the function directory, exactly as `deletion-callers.test.ts` does.
 *
 * The case that matters most is the one that is invisible from inside the database: the deletion
 * transaction COMMITS and stamps its audit row `completed`, and then the response is lost. The
 * handler sees an error indistinguishable from a refusal. If it stamps `failed` by id alone it
 * overwrites the truth — the academy is gone and the durable record says it was not deleted.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleRequest } from "../admin-academy-deletion/index.ts";

const ADMIN = "00000000-0000-4000-8000-00000000ad11";
const AUDIT = "00000000-0000-4000-8000-0000000000a1";

interface StubOptions {
  /** The audit row's CURRENT status, which the stamp's filters are matched against. */
  auditStatus?: string;
  stampError?: { message: string } | null;
  rpcError?: { message: string } | null;
  isAdmin?: boolean;
}

/**
 * The audit row is modelled, not faked: the UPDATE returns a row only when EVERY `eq` filter
 * matches it, exactly as Postgres would. A stub that ignored the filters would let a handler with
 * no `status = 'started'` guard pass the very test written to catch it.
 */
function makeAdmin(opts: StubOptions) {
  const { auditStatus = "started", stampError = null, rpcError = null, isAdmin = true } = opts;
  const stampFilters: Record<string, unknown> = {};
  const auditRow: Record<string, unknown> = { id: AUDIT, status: auditStatus };

  const client = {
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: ADMIN } }, error: null }),
    },
    rpc: (_name: string, _args: unknown) =>
      Promise.resolve({ data: rpcError ? null : { ok: true }, error: rpcError }),
    from: (table: string) => {
      if (table === "user_roles") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({ data: isAdmin ? { role: "admin" } : null, error: null }),
              }),
            }),
          }),
        };
      }
      // academy_deletion_audit
      return {
        insert: () => ({
          select: () => ({ single: () => Promise.resolve({ data: { id: AUDIT }, error: null }) }),
        }),
        update: (_patch: Record<string, unknown>) => {
          const chain = {
            eq: (col: string, val: unknown) => {
              stampFilters[col] = val;
              return chain;
            },
            select: () => {
              const matches = Object.entries(stampFilters)
                .every(([col, val]) => auditRow[col] === val);
              return Promise.resolve({
                data: stampError ? null : (matches ? [{ id: AUDIT }] : []),
                error: stampError,
              });
            },
          };
          return chain;
        },
      };
    },
  };
  return { client: client as never, stampFilters };
}

const confirmRequest = () =>
  new Request("http://localhost/admin-academy-deletion", {
    method: "POST",
    headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "confirm",
      academy_profile_id: "11111111-1111-4111-8111-111111111111",
      expected_digest: "a".repeat(64),
      preview_version: 1,
    }),
  });

Deno.test("an ordinary refusal stamps the audit failed, and only over a row still 'started'", async () => {
  const { client, stampFilters } = makeAdmin({ rpcError: { message: "BLOCKED: HAS_INVOICES" } });
  const res = await handleRequest(confirmRequest(), { admin: client });
  const body = await res.json();

  assertEquals(res.status, 409);
  assertEquals(body.code, "BLOCKED");
  assertEquals(body.audit_incomplete, undefined);
  // the guard itself: without status='started' this update can overwrite a completed row
  assertEquals(stampFilters.status, "started");
  assertEquals(stampFilters.id, AUDIT);
});

Deno.test("a lost response over a COMMITTED deletion never rewrites the completed audit", async () => {
  // The transaction committed and stamped `completed`; the reply did not arrive. The stamp matches
  // no `started` row, so nothing is overwritten and the outcome is reported as indeterminate.
  const { client } = makeAdmin({
    rpcError: { message: "fetch failed" },
    auditStatus: "completed",     // the transaction already stamped it, inside its own commit
  });
  const res = await handleRequest(confirmRequest(), { admin: client });
  const body = await res.json();

  assertEquals(res.status, 409);
  assertEquals(body.audit_incomplete, true);
  assertEquals(body.error, "Deletion outcome is indeterminate.");
});

Deno.test("a failed stamp is reported as audit_incomplete, not as a clean refusal", async () => {
  const { client } = makeAdmin({
    rpcError: { message: "PREVIEW_STALE: changed" },
    stampError: { message: "connection reset" },
  });
  const res = await handleRequest(confirmRequest(), { admin: client });
  const body = await res.json();

  assertEquals(res.status, 409);
  assertEquals(body.code, "PREVIEW_STALE");
  assertEquals(body.audit_incomplete, true);
});

Deno.test("a non-admin is refused before any audit row or RPC exists", async () => {
  let rpcCalled = false;
  const { client } = makeAdmin({ isAdmin: false });
  (client as unknown as { rpc: () => unknown }).rpc = () => {
    rpcCalled = true;
    return Promise.resolve({ data: null, error: null });
  };
  const res = await handleRequest(confirmRequest(), { admin: client });

  assertEquals(res.status, 403);
  assertEquals(rpcCalled, false);
});
