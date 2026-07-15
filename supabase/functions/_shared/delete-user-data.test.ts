import { assertEquals, assertRejects } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { deleteUserData } from "./delete-user-data.ts";

type Row = Record<string, unknown>;

// Fake admin client modelling the A2 (R03) trainer-deletion schema:
//   invoices.trainer_id      -> trainer_profiles.id (SET NULL) — invoices are RETAINED, not deleted
//   invoices.guest_player_id -> guest_players.id    (SET NULL) — nulled when the guest is erased
//   intake_requests.guest_player_id -> guest_players.id (NO ACTION) — still blocks until removed
// The trainer_profiles row is anonymized (update), never deleted; its slots + invoices are retained.
function makeFakeAdmin() {
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
      return Promise.resolve({ data: rows[0] ?? null, error: rows[0] ? null : { message: "not found" } });
    };
    q.then = (res: (v: { data: Row[]; error: null }) => void) =>
      res({ data: (store[t] ?? []).filter((r) => filters.every((f) => f(r))), error: null });
    return q;
  };

  const makeDelete = (t: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    const run = () => {
      callOrder.push(`delete:${t}`);
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
    _removedStoragePaths: removedStoragePaths,
    from(t: string) {
      return {
        select: () => makeSelect(t),
        delete: () => makeDelete(t),
        update: (p: Row) => makeUpdate(t, p),
      };
    },
    storage,
    auth: { admin: { deleteUser: (_id: string) => Promise.resolve({ error: null }) } },
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
      return Promise.resolve({ data: rows[0] ?? null, error: rows[0] ? null : { message: "not found" } });
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