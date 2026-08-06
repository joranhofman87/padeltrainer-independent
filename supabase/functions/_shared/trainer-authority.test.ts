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
  academy_trainers?: Row[]; academy_managers?: Row[];
}, failTable?: string) {
  return {
    from(table: string) {
      const rows = (store as Record<string, Row[] | undefined>)[table] ?? [];
      const filters: Array<(r: Row) => boolean> = [];
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; };
      q.not = (c: string, op: string, list: string) => {
        const vals = list.replace(/^\(|\)$/g, "").split(",");
        if (op === "in") filters.push((r) => !vals.includes(String(r[c])));
        return q;
      };
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
  // the caller manages only A
  academy_managers: [{ user_id: "mgrA", academy_profile_id: "A" }],
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
    academy_managers: [{ user_id: "mgrA", academy_profile_id: "A" }],
  }), "mgrA", "T");
  assertEquals(t?.isExclusiveToCaller, true);
  assertEquals(t?.foreignTenants, []);
});

Deno.test("it reads ONLY tables that exist — a fake cannot invent a schema", async () => {
  // The lesson that made this test necessary: the first version queried `club_trainers`, which is
  // not in this schema at all. Because the fake happily served an in-memory table of that name,
  // every test passed while production would have errored on every call — and, since this function
  // fails closed, silently revoked the capability it exists to preserve. A fake is only evidence
  // about tables the migrations actually create.
  const read: string[] = [];
  const spy = {
    from(table: string) {
      read.push(table);
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.not = () => q;
      q.then = (res: (v: { data: Row[]; error: null }) => void) => res({ data: [], error: null });
      return q;
    },
    // deno-lint-ignore no-explicit-any
  } as any;
  await assessTrainerTenancy(spy, "mgrA", "T");
  // the assertion is on what it READS, not on what the source mentions — the file names
  // club_trainers in a comment precisely to record why it must not be queried
  assertEquals(read.sort(), ["academy_managers", "academy_trainers"]);
});

Deno.test("a PENDING relationship DOES make a trainer shared — only an ended one does not", async () => {
  // the status bypass: exclusivity answered with `status = 'active'` treats an invited or paused
  // association as absent, so a manager gains authority over a trainer another tenant is
  // mid-onboarding. An unfamiliar status must count as somebody's claim, not as nobody's.
  const t = await assessTrainerTenancy(fakeAdmin({
    academy_trainers: [
      { trainer_profile_id: "T", academy_profile_id: "A", status: "active" },
      { trainer_profile_id: "T", academy_profile_id: "B", status: "pending" },
    ],
    academy_managers: [{ user_id: "mgrA", academy_profile_id: "A" }],
  }), "mgrA", "T");
  assertEquals(t?.isExclusiveToCaller, false);
  assertEquals(t?.foreignTenants, ["academy:B"]);
});

Deno.test("an INACTIVE relationship does not make a trainer shared", async () => {
  const t = await assessTrainerTenancy(fakeAdmin({
    academy_trainers: [
      { trainer_profile_id: "T", academy_profile_id: "A", status: "active" },
      { trainer_profile_id: "T", academy_profile_id: "B", status: "inactive" },
    ],
    academy_managers: [{ user_id: "mgrA", academy_profile_id: "A" }],
  }), "mgrA", "T");
  assertEquals(t?.isExclusiveToCaller, true);
});

Deno.test("a trainer with NO active tenancy is nobody's to rename", async () => {
  const t = await assessTrainerTenancy(fakeAdmin({
    academy_trainers: [],
    academy_managers: [{ user_id: "mgrA", academy_profile_id: "A" }],
  }), "mgrA", "T");
  assertEquals(t?.isExclusiveToCaller, false);
});

Deno.test("FAILS CLOSED: an unreadable relationship table never widens authority", async () => {
  for (const table of ["academy_trainers", "academy_managers"]) {
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
