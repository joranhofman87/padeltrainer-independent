import { assertEquals, assertRejects } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { deleteUserData } from "./delete-user-data.ts";

type Row = Record<string, unknown>;

// Fake admin client that models the real NO ACTION FKs:
//   invoices.guest_player_id  -> guest_players.id   (RESTRICT)
//   intake_requests.guest_player_id -> guest_players.id (RESTRICT)
// Deleting guest_players while any such row still references it returns an FK error.
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

  const remainingGuestRefs = () =>
    (store.invoices ?? []).some((r) => r.guest_player_id === "g1") ||
    (store.intake_requests ?? []).some((r) => r.guest_player_id === "g1");

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
      if (t === "guest_players" && remainingGuestRefs()) {
        return Promise.resolve({
          error: { code: "23503", message: "update or delete on guest_players violates FK" },
        });
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

  const admin = {
    _callOrder: callOrder,
    from(t: string) {
      return {
        select: () => makeSelect(t),
        delete: () => makeDelete(t),
        update: (_p: Row) => ({ eq: () => Promise.resolve({ data: null, error: null }), in: () => Promise.resolve({ data: null, error: null }) }),
      };
    },
    auth: { admin: { deleteUser: (_id: string) => Promise.resolve({ error: null }) } },
  };
  return admin as unknown as SupabaseClient & { _callOrder: string[] };
}

Deno.test("deleteUserData removes invoices + intake_requests before guest_players (no swallowed FK error)", async () => {
  const admin = makeFakeAdmin();
  await deleteUserData(admin, "u1");
  const order = (admin as unknown as { _callOrder: string[] })._callOrder;
  const gIdx = order.indexOf("delete:guest_players");
  const invIdx = order.indexOf("delete:invoices");
  const irIdx = order.indexOf("delete:intake_requests");
  // guest_players must come AFTER both blocking refs.
  assertEquals(invIdx !== -1 && invIdx < gIdx, true, "invoices deleted before guest_players");
  assertEquals(irIdx !== -1 && irIdx < gIdx, true, "intake_requests deleted before guest_players");
});

Deno.test("deleteUserData THROWS (never swallows) when a guest_players FK delete is rejected", async () => {
  // Force the pre-fix ordering hazard: an extra invoice inserted mid-flight would
  // be caught by runDelete. Here we simply assert the helper surfaces a real error.
  const admin = makeFakeAdmin();
  // Sabotage: make invoices delete a no-op so a ref survives past guest_players.
  const orig = admin.from.bind(admin);
  (admin as unknown as { from: (t: string) => unknown }).from = (t: string) => {
    if (t === "invoices") {
      return { select: () => ({ eq: () => ({ then: (r: (v: { data: Row[]; error: null }) => void) => r({ data: [], error: null }) }) }), delete: () => ({ eq: () => Promise.resolve({ error: null }) }), update: () => ({ eq: () => Promise.resolve({ error: null }) }) };
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