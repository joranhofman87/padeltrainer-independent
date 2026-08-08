import { assertEquals, assertRejects } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";
import { deleteUserData } from "./delete-user-data.ts";

type Row = Record<string, unknown>;

// Fake admin client modelling the A2 (R03) trainer-deletion schema:
//   invoices.trainer_id      -> trainer_profiles.id (SET NULL) — invoices are RETAINED, not deleted
//   invoices.guest_player_id -> guest_players.id    (SET NULL) — nulled when the guest is erased
//   intake_requests.guest_player_id -> guest_players.id (NO ACTION) — still blocks until removed
// The trainer_profiles row is anonymized (update), never deleted; its slots + invoices are retained.
/**
 * `fail` injects a database error on one table+operation, which is the only way to test the
 * property that matters here: a cleanup step that fails must stop the run BEFORE the auth account
 * is deleted. Awaiting a Supabase builder never rejects — it resolves to `{ error }` — so a test
 * that only exercises the happy path proves nothing about the failure ordering.
 */
function makeFakeAdmin(
  fail?: { table: string; op: "delete" | "update" | "select" },
  // The U1c preflight probe. Default: no memberships, so every pre-existing test behaves as before.
  preflight?: { has_memberships?: boolean; membership_count?: number; person_ids?: string[]; error?: unknown },
) {
  const store: Record<string, Row[]> = {
    trainer_profiles: [{ id: "tp1", user_id: "u1" }],
    profiles: [], // no player profile
    guest_players: [{ id: "g1", trainer_id: "tp1" }],
    invoices: [{ id: "inv1", trainer_id: "tp1", guest_player_id: "g1" }],
    intake_requests: [{ id: "ir1", cycle_id: "c1", guest_player_id: "g1" }],
    cycles: [{ id: "c1", owner_type: "trainer", owner_id: "tp1" }],
    availability_slots: [{ id: "s1", trainer_id: "tp1" }],
    club_profiles: [],
    academy_profiles: [],
  };
  const callOrder: string[] = [];

  // Only intake_requests (NO ACTION) can still block the guest delete; invoices are SET NULL.
  const intakeStillRefsGuest = () => (store.intake_requests ?? []).some((r) => r.guest_player_id === "g1");

  const makeSelect = (t: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; };
    q.single = () => {
      const rows = (store[t] ?? []).filter((r) => filters.every((f) => f(r)));
      return Promise.resolve({
        data: rows[0] ?? null,
        // PostgREST's real shape: .single() finding nothing is PGRST116, which is an ANSWER, not a
        // failure. Without the code a caller that (correctly) fails closed on read errors cannot
        // tell "this user has no trainer profile" from "the query broke".
        error: rows[0] ? null : { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" },
      });
    };
    q.then = (res: (v: { data: Row[] | null; error: unknown }) => void) =>
      res(fail?.table === t && fail.op === "select"
        ? { data: null, error: { code: "42501", message: `injected failure reading ${t}` } }
        : { data: (store[t] ?? []).filter((r) => filters.every((f) => f(r))), error: null });
    return q;
  };

  const makeDelete = (t: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    const run = () => {
      callOrder.push(`delete:${t}`);
      if (fail?.table === t && fail.op === "delete") {
        return Promise.resolve({ error: { code: "42501", message: `injected failure deleting ${t}` } });
      }
      if (t === "guest_players") {
        if (intakeStillRefsGuest()) {
          return Promise.resolve({ error: { code: "23503", message: "update or delete on guest_players violates FK" } });
        }
        // SET NULL: erasing the guest nulls the retained invoices' + bookings' guest_player_id.
        for (const r of store.invoices ?? []) if (r.guest_player_id === "g1") r.guest_player_id = null;
      }
      store[t] = (store[t] ?? []).filter((r) => !filters.every((f) => f(r)));
      return Promise.resolve({ error: null });
    };
    const d: Record<string, unknown> = {};
    const thenable = { then: (res: (v: { error: unknown }) => void) => run().then(res) };
    d.eq = (c: string, v: unknown) => { filters.push((r) => r[c] === v); return thenable; };
    d.in = (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return thenable; };
    return d;
  };

  const makeUpdate = (t: string, patch: Row) => {
    const filters: Array<(r: Row) => boolean> = [];
    const run = () => {
      callOrder.push(`update:${t}`);
      if (fail?.table === t && fail.op === "update") {
        return Promise.resolve({ data: null, error: { code: "42501", message: `injected failure updating ${t}` } });
      }
      for (const r of store[t] ?? []) if (filters.every((f) => f(r))) Object.assign(r, patch);
      return Promise.resolve({ data: null, error: null });
    };
    const u: Record<string, unknown> = {};
    u.eq = (c: string, v: unknown) => { filters.push((r) => r[c] === v); return run(); };
    u.in = (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return run(); };
    return u;
  };

  // Storage stub (R06 avatar cleanup): one avatar object under the user's folder; records removes.
  const removedStoragePaths: string[] = [];
  const storage = {
    from: (_bucket: string) => ({
      list: (prefix: string) => Promise.resolve({ data: prefix === "u1" ? [{ name: "avatar.png" }] : [], error: null }),
      remove: (paths: string[]) => { removedStoragePaths.push(...paths); return Promise.resolve({ data: null, error: null }); },
    }),
  };

  const admin = {
    _store: store,
    _callOrder: callOrder,
    // Recorded in callOrder like every other operation, so a test can assert the preflight ran FIRST
    // rather than merely that it ran.
    rpc: (fn: string, _args: Record<string, unknown>) => {
      callOrder.push(`rpc:${fn}`);
      if (preflight?.error) return Promise.resolve({ data: null, error: preflight.error });
      return Promise.resolve({
        data: {
          user_id: "u1",
          person_ids: preflight?.person_ids ?? [],
          membership_count: preflight?.membership_count ?? 0,
          has_memberships: preflight?.has_memberships ?? false,
        },
        error: null,
      });
    },
    _removedStoragePaths: removedStoragePaths,
    from(t: string) {
      return {
        select: () => makeSelect(t),
        delete: () => makeDelete(t),
        update: (p: Row) => makeUpdate(t, p),
      };
    },
    storage,
    auth: {
      admin: {
        deleteUser: (_id: string) => {
          callOrder.push("auth:deleteUser");
          return Promise.resolve({ error: null });
        },
      },
    },
  };
  return admin as unknown as SupabaseClient & { _store: Record<string, Row[]>; _callOrder: string[]; _removedStoragePaths: string[] };
}

Deno.test("deleteUserData RETAINS the trainer's invoices + slots and anonymizes the trainer shell (R03)", async () => {
  const admin = makeFakeAdmin();
  await deleteUserData(admin, "u1");
  const store = (admin as unknown as { _store: Record<string, Row[]> })._store;
  const order = (admin as unknown as { _callOrder: string[] })._callOrder;

  // Financial records retained — never deleted in the trainer branch.
  assertEquals(store.invoices.length, 1, "invoices retained");
  assertEquals(store.availability_slots.length, 1, "slots retained");
  assertEquals(order.includes("delete:invoices"), false, "invoices are not deleted");
  assertEquals(order.includes("delete:availability_slots"), false, "trainer slots are not deleted");

  // The trainer row is anonymized (updated) into a shell, not deleted.
  assertEquals(order.includes("delete:trainer_profiles"), false, "trainer_profiles not hard-deleted");
  assertEquals(order.includes("update:trainer_profiles"), true, "trainer_profiles anonymized");
  assertEquals(store.trainer_profiles[0].user_id, null, "shell user_id detached");
  assertEquals(typeof store.trainer_profiles[0].anonymized_at, "string", "shell anonymized_at stamped");

  // Guests are still erased; the retained invoice's guest reference is SET NULL.
  assertEquals(store.guest_players.length, 0, "guest players erased");
  assertEquals(store.invoices[0].guest_player_id, null, "retained invoice guest ref nulled");

  // R06: the user's avatar objects (public bucket, user-keyed folder) are removed.
  const removed = (admin as unknown as { _removedStoragePaths: string[] })._removedStoragePaths;
  assertEquals(removed, ["u1/avatar.png"], "avatar objects removed on account deletion");
});

Deno.test("deleteUserData THROWS (never swallows) when the guest_players delete is FK-rejected", async () => {
  const admin = makeFakeAdmin();
  // Sabotage: make intake_requests delete a no-op so a NO ACTION ref survives past guest_players.
  const orig = admin.from.bind(admin);
  (admin as unknown as { from: (t: string) => unknown }).from = (t: string) => {
    if (t === "intake_requests") {
      return {
        select: () => ({ eq: () => ({ then: (r: (v: { data: Row[]; error: null }) => void) => r({ data: [], error: null }) }) }),
        delete: () => ({ eq: () => Promise.resolve({ error: null }), in: () => Promise.resolve({ error: null }) }),
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      };
    }
    return (orig as (t: string) => unknown)(t);
  };
  await assertRejects(() => deleteUserData(admin, "u1"), Error, "guest_players");
});

// Audit §4.6: the club/academy branches must delete the cycles' availability_slots (so bookings +
// priority claims + session data CASCADE), not only the cycle (which SET-NULLs the slots into orphans).
function makeOrgAdmin(orgType: "club" | "academy") {
  const profileTable = orgType === "club" ? "club_profiles" : "academy_profiles";
  const store: Record<string, Row[]> = {
    [profileTable]: [{ id: "org1", created_by: "u1" }],
    cycles: [{ id: "oc1", owner_type: orgType, owner_id: "org1" }],
    availability_slots: [{ id: "os1", cyclus_id: "oc1" }],
    intake_requests: [{ id: "oir1", cycle_id: "oc1" }],
    trainer_profiles: [],
    profiles: [],
  };
  const callOrder: string[] = [];
  const makeSelect = (t: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; };
    q.in = (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return q; };
    q.single = () => {
      const rows = (store[t] ?? []).filter((r) => filters.every((f) => f(r)));
      return Promise.resolve({
        data: rows[0] ?? null,
        // PostgREST's real shape: .single() finding nothing is PGRST116, which is an ANSWER, not a
        // failure. Without the code a caller that (correctly) fails closed on read errors cannot
        // tell "this user has no trainer profile" from "the query broke".
        error: rows[0] ? null : { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" },
      });
    };
    q.then = (res: (v: { data: Row[]; error: null }) => void) =>
      res({ data: (store[t] ?? []).filter((r) => filters.every((f) => f(r))), error: null });
    return q;
  };
  const makeDelete = (t: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    const run = () => { callOrder.push(`delete:${t}`); store[t] = (store[t] ?? []).filter((r) => !filters.every((f) => f(r))); return Promise.resolve({ error: null }); };
    const thenable = { then: (res: (v: { error: unknown }) => void) => run().then(res) };
    const d: Record<string, unknown> = {};
    d.eq = (c: string, v: unknown) => { filters.push((r) => r[c] === v); return thenable; };
    d.in = (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return thenable; };
    return d;
  };
  const admin = {
    _store: store, _callOrder: callOrder,
    from(t: string) {
      return {
        select: () => makeSelect(t),
        delete: () => makeDelete(t),
        update: (_p: Row) => ({ eq: () => Promise.resolve({ data: null, error: null }), in: () => Promise.resolve({ data: null, error: null }) }),
      };
    },
    // The U1c preflight probe: this fixture models an account with no memberships.
    rpc: (_fn: string, _args: Record<string, unknown>) =>
      Promise.resolve({ data: { has_memberships: false, membership_count: 0, person_ids: [] }, error: null }),
    auth: { admin: { deleteUser: (_id: string) => Promise.resolve({ error: null }) } },
  };
  return admin as unknown as SupabaseClient & { _store: Record<string, Row[]>; _callOrder: string[] };
}

for (const orgType of ["club", "academy"] as const) {
  Deno.test(`deleteUserData deletes the ${orgType}'s cycle SLOTS before the cycle (no orphans)`, async () => {
    const admin = makeOrgAdmin(orgType);
    await deleteUserData(admin, "u1");
    const s = (admin as unknown as { _store: Record<string, Row[]> })._store;
    const order = (admin as unknown as { _callOrder: string[] })._callOrder;
    assertEquals(s.availability_slots.length, 0, "cycle slots deleted, not orphaned");
    assertEquals(s.cycles.length, 0, "cycle deleted");
    const slotIdx = order.indexOf("delete:availability_slots");
    const cycIdx = order.indexOf("delete:cycles");
    assertEquals(slotIdx !== -1 && slotIdx < cycIdx, true, "slots deleted before cycle");
  });
}
// ── A1/A6 F2: the deletion must FAIL CLOSED, and the auth account must be the last thing to go ──
//
// The defect this closes: every step awaited its Supabase builder without inspecting `{ error }`.
// A builder resolves rather than rejects, so a failed delete looked exactly like a successful one
// and the run continued — to deleting the auth user. The result is the worst version of an
// incomplete privacy operation: the rows survive, and the identity that could have found them
// does not.

Deno.test("a failed DELETE aborts before the auth account is removed", async () => {
  for (const table of ["notification_preferences", "user_roles", "profiles", "banner_events"]) {
    const admin = makeFakeAdmin({ table, op: "delete" });
    await assertRejects(
      () => deleteUserData(admin, "u1"),
      Error,
      table,                                            // the error names what failed
    );
    assertEquals(
      admin._callOrder.includes("auth:deleteUser"), false,
      `${table}: the auth account was deleted after a failed cleanup step`,
    );
  }
});

Deno.test("a failed ANONYMIZING UPDATE aborts too — a retained row must not keep the departed identity", async () => {
  const admin = makeFakeAdmin({ table: "trainer_profiles", op: "update" });
  await assertRejects(() => deleteUserData(admin, "u1"), Error, "trainer_profiles");
  assertEquals(admin._callOrder.includes("auth:deleteUser"), false);
});

Deno.test("a failed READ aborts: 'no rows' and 'the query broke' must not be the same answer", async () => {
  // the subtlest arm. A read that decides WHAT to delete, returning [] because it failed, means
  // those rows are silently skipped — and then the account is deleted anyway.
  const admin = makeFakeAdmin({ table: "cycles", op: "select" });
  await assertRejects(() => deleteUserData(admin, "u1"), Error, "cycles");
  assertEquals(admin._callOrder.includes("auth:deleteUser"), false);
});

Deno.test("the happy path still reaches the auth deletion, and reaches it LAST", async () => {
  const admin = makeFakeAdmin();
  await deleteUserData(admin, "u1");
  const order = admin._callOrder;
  assertEquals(order.includes("auth:deleteUser"), true);
  assertEquals(order[order.length - 1], "auth:deleteUser");   // nothing runs after it
});

// ══ U1c prerequisite 2 — the account-deletion preflight ═══════════════════════════════════════════
//
// `academy_player_memberships.person_id` is ON DELETE RESTRICT, so deleting a person that holds a
// membership aborts. deleteUserData is ~60 independently-committed calls, and TWO of them destroy
// person sources: the trainer's guests (about two-thirds through) and the profile (last). An abort at
// either leaves the account partially deleted. Hence a preflight — and hence these tests are mostly
// about WHEN it runs, not merely that it does.

Deno.test("the preflight runs BEFORE the first destructive operation, not merely before auth deletion", async () => {
  const admin = makeFakeAdmin(undefined, { has_memberships: true, membership_count: 2, person_ids: ["p1"] });

  const err = await assertRejects(() => deleteUserData(admin, "u1")) as { code?: string };
  assertEquals(err.code, "ACCOUNT_HAS_MEMBERSHIPS");

  // THE assertion. Not "auth:deleteUser is absent" — that would also hold if the check sat at the very
  // end, which is exactly the placement this guard exists to rule out. Nothing but the probe ran.
  assertEquals(admin._callOrder, ["rpc:account_membership_preflight"]);
});

Deno.test("a refused deletion leaves every row intact", async () => {
  const admin = makeFakeAdmin(undefined, { has_memberships: true, membership_count: 1, person_ids: ["p1"] });
  const before = JSON.stringify(admin._store);

  await assertRejects(() => deleteUserData(admin, "u1"));

  assertEquals(JSON.stringify(admin._store), before);
  assertEquals(admin._removedStoragePaths, []);            // not even the avatar objects
  assertEquals(admin._callOrder.includes("auth:deleteUser"), false);
});

Deno.test("the refusal carries a machine-readable code and the counts", async () => {
  const admin = makeFakeAdmin(undefined, { has_memberships: true, membership_count: 3, person_ids: ["p1", "p2"] });
  const err = await assertRejects(() => deleteUserData(admin, "u1")) as {
    code?: string; membershipCount?: number; personIds?: string[];
  };
  // Callers branch on the code, never on message text: the bulk job has to tell "skip" from "broke".
  assertEquals(err.code, "ACCOUNT_HAS_MEMBERSHIPS");
  assertEquals(err.membershipCount, 3);
  assertEquals(err.personIds, ["p1", "p2"]);
});

Deno.test("the preflight FAILS CLOSED when the probe itself errors", async () => {
  // "We could not check" must never be treated as "there is nothing to find" — that is precisely how
  // a partial deletion happens.
  const admin = makeFakeAdmin(undefined, { error: { code: "42501", message: "permission denied" } });
  await assertRejects(() => deleteUserData(admin, "u1"), Error, "preflight failed");
  assertEquals(admin._callOrder, ["rpc:account_membership_preflight"]);
});

Deno.test("the preflight fails closed on an unusable probe result", async () => {
  const admin = makeFakeAdmin();
  (admin as unknown as { rpc: unknown }).rpc = (_fn: string) =>
    Promise.resolve({ data: { nonsense: true }, error: null });
  await assertRejects(() => deleteUserData(admin, "u1"), Error, "unusable result");
});

Deno.test("an account with NO memberships still deletes, and the probe ran first", async () => {
  const admin = makeFakeAdmin();   // default: has_memberships false
  await deleteUserData(admin, "u1");
  assertEquals(admin._callOrder[0], "rpc:account_membership_preflight");
  assertEquals(admin._callOrder.at(-1), "auth:deleteUser");
});
