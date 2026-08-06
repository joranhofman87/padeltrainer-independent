import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { assessTrainerTenancy, GLOBAL_IDENTITY_FIELDS } from "./trainer-authority.ts";

/**
 * A1-A7 F3 — one academy must not own a SHARED trainer's global identity.
 *
 * The scenario the finding names: trainer T works for academy A and academy B. A manager of A
 * could change T's auth email (rotating the login B depends on) and T's shared profile (rewriting
 * the name and photo B shows). The authority check proved the caller managed *a* tenant of T's,
 * and then scoped nothing.
 */

type Row = Record<string, unknown>;

function fakeAdmin(store: {
  academy_trainers?: Row[]; club_trainers?: Row[];
  academy_managers?: Row[]; club_managers?: Row[];
}, failTable?: string) {
  return {
    from(table: string) {
      const rows = (store as Record<string, Row[] | undefined>)[table] ?? [];
      const filters: Array<(r: Row) => boolean> = [];
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; };
      q.then = (res: (v: { data: Row[] | null; error: unknown }) => void) =>
        res(failTable === table
          ? { data: null, error: { message: `injected failure reading ${table}` } }
          : { data: rows.filter((r) => filters.every((f) => f(r))), error: null });
      return q;
    },
    // deno-lint-ignore no-explicit-any
  } as any;
}

const SHARED = {
  // T is active in BOTH academies
  academy_trainers: [
    { trainer_profile_id: "T", academy_profile_id: "A", status: "active" },
    { trainer_profile_id: "T", academy_profile_id: "B", status: "active" },
  ],
  club_trainers: [],
  // the caller manages only A
  academy_managers: [{ user_id: "mgrA", academy_profile_id: "A" }],
  club_managers: [],
};

Deno.test("a SHARED trainer is not exclusive to either academy's manager", async () => {
  const t = await assessTrainerTenancy(fakeAdmin(SHARED), "mgrA", "T");
  assertEquals(t?.isExclusiveToCaller, false);
  assertEquals(t?.managedTenants, ["academy:A"]);
  assertEquals(t?.foreignTenants, ["academy:B"]);   // the reason a refusal can explain itself
});

Deno.test("an EXCLUSIVE trainer still belongs to the academy that manages them", async () => {
  const t = await assessTrainerTenancy(fakeAdmin({
    academy_trainers: [{ trainer_profile_id: "T", academy_profile_id: "A", status: "active" }],
    club_trainers: [],
    academy_managers: [{ user_id: "mgrA", academy_profile_id: "A" }],
    club_managers: [],
  }), "mgrA", "T");
  assertEquals(t?.isExclusiveToCaller, true);
  assertEquals(t?.foreignTenants, []);
});

Deno.test("a CLUB relationship counts too — exclusivity is across every tenant kind", async () => {
  const t = await assessTrainerTenancy(fakeAdmin({
    academy_trainers: [{ trainer_profile_id: "T", academy_profile_id: "A", status: "active" }],
    club_trainers: [{ trainer_profile_id: "T", club_profile_id: "C", status: "active" }],
    academy_managers: [{ user_id: "mgrA", academy_profile_id: "A" }],
    club_managers: [],
  }), "mgrA", "T");
  assertEquals(t?.isExclusiveToCaller, false);
  assertEquals(t?.foreignTenants, ["club:C"]);
});

Deno.test("an INACTIVE relationship does not make a trainer shared", async () => {
  const t = await assessTrainerTenancy(fakeAdmin({
    academy_trainers: [
      { trainer_profile_id: "T", academy_profile_id: "A", status: "active" },
      { trainer_profile_id: "T", academy_profile_id: "B", status: "inactive" },
    ],
    club_trainers: [],
    academy_managers: [{ user_id: "mgrA", academy_profile_id: "A" }],
    club_managers: [],
  }), "mgrA", "T");
  assertEquals(t?.isExclusiveToCaller, true);
});

Deno.test("a trainer with NO active tenancy is nobody's to rename", async () => {
  const t = await assessTrainerTenancy(fakeAdmin({
    academy_trainers: [], club_trainers: [],
    academy_managers: [{ user_id: "mgrA", academy_profile_id: "A" }], club_managers: [],
  }), "mgrA", "T");
  assertEquals(t?.isExclusiveToCaller, false);
});

Deno.test("FAILS CLOSED: an unreadable relationship table never widens authority", async () => {
  for (const table of ["academy_trainers", "club_trainers", "academy_managers", "club_managers"]) {
    const t = await assessTrainerTenancy(fakeAdmin(SHARED, table), "mgrA", "T");
    assertEquals(t, null, `${table}: a read failure must not resolve to a tenancy`);
  }
});

Deno.test("the global-identity field list covers every shared profile field the endpoint writes", async () => {
  // the matrix is only as good as its list: a profile column added to update-user without being
  // classified here would be writable by a manager of a shared trainer.
  const src = await Deno.readTextFile(new URL("../update-user/index.ts", import.meta.url));
  const written = [...src.matchAll(/updates\.([a-z_]+) = /g)].map((m) => m[1]);
  const unclassified = written.filter((f) => !(GLOBAL_IDENTITY_FIELDS as readonly string[]).includes(f));
  assertEquals(unclassified, [], `update-user writes ${unclassified.join(", ")} without classifying it`);
});
