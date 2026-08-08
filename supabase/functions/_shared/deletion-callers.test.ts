/**
 * U1c prerequisite 2 — the THREE CALLER CONTRACTS.
 *
 * `delete-user-data.test.ts` proves the shared helper refuses and where. This file proves what each
 * route does with that refusal, by driving the REAL exported handlers — the same function
 * `Deno.serve` is wired to — rather than a copy of their logic. The only injection is the admin
 * client; production passes nothing and builds it from the environment exactly as before.
 *
 * These are the contracts a human or another system actually sees: an HTTP status, a message, an
 * audit row, a response body. A test of the helper alone cannot tell you whether the self-service
 * route returns your wording or leaks a stack trace.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";

import { handleRequest as adminDeleteUser } from "../delete-user/index.ts";
import { handleRequest as selfServiceDelete } from "../request-account-deletion/index.ts";
import { handleRequest as bulkCleanup } from "../bulk-cleanup-users/index.ts";

type Row = Record<string, unknown>;

const ADMIN_USER = "admin-user-1";
const SUBJECT = "subject-user-1";
const ELIGIBLE = "eligible-user-1";

/**
 * One fake admin client covering all three routes.
 *
 * `destructiveOps` records every delete/update issued against a NON-audit table. That list is the
 * proof the refusal tests need: "no destructive operation" has to mean none was issued, not merely
 * that the auth account survived.
 */
function makeAdmin(opts: {
  membershipsFor?: Record<string, { count: number }>;
  profiles?: Row[];
  callerId?: string;
  failAuditInsert?: boolean;
}) {
  // Audit tables are exempt only for the operations the routes legitimately perform: INSERT (the
  // record itself) and the status UPDATE. A DELETE of an audit row is destructive by any measure, and
  // exempting it wholesale would let a mistaken erasure of the evidence pass the refusal assertions.
  const AUDIT_UPDATE_EXEMPT = new Set(["account_deletion_audit"]);
  const destructiveOps: string[] = [];
  const inserted: Record<string, Row[]> = {};
  const updated: Record<string, Row[]> = {};

  const store: Record<string, Row[]> = {
    profiles: opts.profiles ?? [{ user_id: SUBJECT, email: "s@example.com", full_name: "S" }],
    // the CALLER is the admin; the subject is not, or bulk cleanup would preserve them
    user_roles: [{ user_id: ADMIN_USER, role: "admin" }],
    trainer_profiles: [],
    club_profiles: [],
    academy_profiles: [],
  };

  const table = (t: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    const api: Record<string, unknown> = {};
    const rows = () => (store[t] ?? []).filter((r) => filters.every((f) => f(r)));

    api.select = () => api;
    api.eq = (c: string, v: unknown) => { filters.push((r) => r[c] === v); return api; };
    api.in = (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return api; };
    api.not = () => api;
    api.limit = () => api;
    api.maybeSingle = () => Promise.resolve({ data: rows()[0] ?? null, error: null });
    api.single = () => Promise.resolve({
      data: rows()[0] ?? null,
      error: rows()[0] ? null : { code: "PGRST116", message: "no rows" },
    });
    api.insert = (payload: Row) => {
      const failed = opts.failAuditInsert && t === "admin_impersonation_logs";
      if (!failed) (inserted[t] ??= []).push(payload);
      const err = failed ? { code: "42501", message: "injected audit insert failure" } : null;
      const ret: Record<string, unknown> = {};
      ret.select = () => ret;
      ret.single = () => Promise.resolve({ data: failed ? null : { id: `${t}-row-1` }, error: err });
      (ret as { then: unknown }).then = (res: (v: { error: unknown }) => void) => res({ error: err });
      return ret;
    };
    api.update = (payload: Row) => {
      if (!AUDIT_UPDATE_EXEMPT.has(t)) destructiveOps.push(`update:${t}`);
      (updated[t] ??= []).push(payload);
      const u: Record<string, unknown> = {};
      u.eq = () => u;
      (u as { then: unknown }).then = (res: (v: { error: unknown }) => void) => res({ error: null });
      return u;
    };
    api.delete = () => {
      destructiveOps.push(`delete:${t}`);   // every delete counts, audit tables included
      const d: Record<string, unknown> = {};
      d.eq = () => d;
      d.in = () => d;
      (d as { then: unknown }).then = (res: (v: { error: unknown }) => void) => res({ error: null });
      return d;
    };
    (api as { then: unknown }).then = (res: (v: { data: Row[]; error: unknown }) => void) =>
      res({ data: rows(), error: null });
    return api;
  };

  const admin = {
    _destructiveOps: destructiveOps,
    _inserted: inserted,
    _updated: updated,
    from: (t: string) => table(t),
    rpc: (_fn: string, args: Record<string, unknown>) => {
      const uid = args._user_id as string;
      const hit = opts.membershipsFor?.[uid];
      return Promise.resolve({
        data: {
          user_id: uid,
          person_ids: hit ? ["person-1"] : [],
          membership_count: hit?.count ?? 0,
          has_memberships: !!hit,
        },
        error: null,
      });
    },
    storage: {
      from: () => ({
        list: () => Promise.resolve({ data: [], error: null }),
        remove: () => Promise.resolve({ data: null, error: null }),
      }),
    },
    auth: {
      getUser: (_t: string) => Promise.resolve({ data: { user: { id: opts.callerId ?? SUBJECT } }, error: null }),
      admin: {
        deleteUser: (id: string) => { destructiveOps.push(`auth:deleteUser:${id}`); return Promise.resolve({ error: null }); },
      },
    },
  };
  return admin as unknown as SupabaseClient & {
    _destructiveOps: string[]; _inserted: Record<string, Row[]>; _updated: Record<string, Row[]>;
  };
}

const post = (body: unknown, auth = true) =>
  new Request("https://edge.test/fn", {
    method: "POST",
    headers: auth ? { authorization: "Bearer t", "content-type": "application/json" } : { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// ══ 1. ADMIN ═════════════════════════════════════════════════════════════════════════════════════
Deno.test("admin delete-user: a membership refusal reaches NO destructive operation", async () => {
  const admin = makeAdmin({ membershipsFor: { [SUBJECT]: { count: 2 } } });
  const res = await adminDeleteUser(post({ target_user_id: SUBJECT }), { admin });

  // the existing admin contract is a non-2xx with the error surfaced; what matters here is that the
  // account is untouched.
  assertEquals(res.ok, false);
  assertEquals(admin._destructiveOps, []);
});

// ══ 2. SELF-SERVICE ══════════════════════════════════════════════════════════════════════════════
Deno.test("self-service: exact 409 message + code, audit failed with the machine-readable prefix, nothing deleted", async () => {
  const admin = makeAdmin({ membershipsFor: { [SUBJECT]: { count: 1 } } });
  const res = await selfServiceDelete(post({}), { admin });

  assertEquals(res.status, 409);
  const body = await res.json();
  assertEquals(
    body.error,
    "Your account has player records that must be handled before it can be deleted. Please contact support.",
  );
  assertEquals(body.code, "ACCOUNT_HAS_MEMBERSHIPS");

  // the audit row is stamped failed, and the reason leads with the code so it can be filtered on
  const stamps = admin._updated["account_deletion_audit"] ?? [];
  assertEquals(stamps.length, 1);
  assertEquals(stamps[0].status, "failed");
  assertStringIncludes(String(stamps[0].failure_reason), "ACCOUNT_HAS_MEMBERSHIPS:");

  // and nothing of the account was touched
  assertEquals(admin._destructiveOps, []);
});

// ══ 3. BULK ══════════════════════════════════════════════════════════════════════════════════════
Deno.test("bulk cleanup: the skip is durable per account, processing continues, both outcomes reported", async () => {
  const admin = makeAdmin({
    callerId: ADMIN_USER,
    membershipsFor: { [SUBJECT]: { count: 3 } },
    profiles: [
      { user_id: SUBJECT, email: "skipme@example.com" },
      { user_id: ELIGIBLE, email: "deleteme@example.com" },
    ],
  });

  const res = await bulkCleanup(post({ confirm: true }), { admin });
  assertEquals(res.status, 200);
  const body = await res.json();

  // the refusal did not stop the run: the eligible user was still processed
  assertEquals(body.skipped.length, 1);
  assertEquals(body.deleted.length, 1);
  assertStringIncludes(body.deleted[0], ELIGIBLE);
  assertStringIncludes(body.message, "skipped 1");

  // DURABLE and per-account: the audit carries the id, the code and the count — not just a tally.
  const audit = (admin._inserted["admin_impersonation_logs"] ?? [])[0];
  const details = audit.details as { skipped_count: number; skipped_details: Array<Record<string, unknown>> };
  assertEquals(details.skipped_count, 1);
  assertEquals(details.skipped_details, [
    { user_id: SUBJECT, code: "ACCOUNT_HAS_MEMBERSHIPS", membership_count: 3 },
  ]);

  // ...and no email address rode along into the durable record — checked across the WHOLE details
  // payload, not just the skip projection, so a future field cannot smuggle one in.
  assertEquals(JSON.stringify(details).includes("@"), false);

  // the skipped user's auth account is untouched; the eligible one's is not
  assertEquals(admin._destructiveOps.includes(`auth:deleteUser:${SUBJECT}`), false);
  assertEquals(admin._destructiveOps.includes(`auth:deleteUser:${ELIGIBLE}`), true);
});

Deno.test("bulk cleanup: a FAILED audit insert is reported, not swallowed as clean success", async () => {
  // The audit row is now the only durable record of which accounts were skipped. If the insert fails
  // silently, the deletions still happened, the skips are unrecorded, and the caller is told all is
  // well — which is exactly the shape of problem this whole slice exists to prevent.
  const admin = makeAdmin({
    callerId: ADMIN_USER,
    membershipsFor: { [SUBJECT]: { count: 3 } },
    profiles: [
      { user_id: SUBJECT, email: "skipme@example.com" },
      { user_id: ELIGIBLE, email: "deleteme@example.com" },
    ],
    failAuditInsert: true,
  });

  const res = await bulkCleanup(post({ confirm: true }), { admin });
  const body = await res.json();
  assertEquals(body.audit_incomplete, true);
});
