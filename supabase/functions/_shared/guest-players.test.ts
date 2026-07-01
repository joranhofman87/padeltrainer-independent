import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { matchGuestByName, normalizeGuestName, resolveOrCreateGuestPlayer } from "./guest-players.ts";

Deno.test("normalizeGuestName trims, lowercases, collapses whitespace", () => {
  assertEquals(normalizeGuestName("  Jan   de  Vries "), "jan de vries");
  assertEquals(normalizeGuestName("JAN"), "jan");
  assertEquals(normalizeGuestName(null), "");
  assertEquals(normalizeGuestName(undefined), "");
});

Deno.test("matchGuestByName reuses the same-name row (family rule)", () => {
  const rows = [
    { id: "g1", full_name: "Jan de Vries" },
    { id: "g2", full_name: "Piet de Vries" },
  ];
  assertEquals(matchGuestByName(rows, "jan de vries")?.id, "g1");
  assertEquals(matchGuestByName(rows, "  PIET   DE VRIES ")?.id, "g2");
});

Deno.test("matchGuestByName returns null for a different name (sibling gets own row)", () => {
  const rows = [{ id: "g1", full_name: "Jan de Vries" }];
  assertEquals(matchGuestByName(rows, "Sanne de Vries"), null);
  assertEquals(matchGuestByName([], "Jan"), null);
  assertEquals(matchGuestByName(null, "Jan"), null);
});

// --- resolveOrCreateGuestPlayer against a tiny in-memory fake admin client ---

type Row = Record<string, unknown>;

function fakeAdmin(seed: Row[]) {
  const table = [...seed];
  const inserted: Row[] = [];
  const updated: Row[] = [];
  const makeQuery = () => {
    const filters: Array<(r: Row) => boolean> = [];
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = (col: string, val: unknown) => {
      filters.push((r) => r[col] === val);
      return q;
    };
    q.is = (col: string, val: unknown) => {
      filters.push((r) => (r[col] ?? null) === val);
      return q;
    };
    // Awaiting the builder resolves the filtered rows.
    q.then = (resolve: (v: { data: Row[] }) => void) =>
      resolve({ data: table.filter((r) => filters.every((f) => f(r))) });
    return q;
  };
  return {
    _inserted: inserted,
    _updated: updated,
    from(_t: string) {
      return {
        select: () => makeQuery(),
        eq: (col: string, val: unknown) => {
          const query = makeQuery();
          return (query.eq as (c: string, v: unknown) => unknown)(col, val);
        },
        update(patch: Row) {
          return {
            eq: (_c: string, id: unknown) => {
              updated.push({ id, ...patch });
              return Promise.resolve({ data: null, error: null });
            },
          };
        },
        insert(row: Row) {
          const created = { id: `new-${inserted.length + 1}`, ...row };
          inserted.push(created);
          return {
            select: () => ({
              single: () => Promise.resolve({ data: { id: created.id }, error: null }),
            }),
          };
        },
      };
    },
  };
}

Deno.test("resolveOrCreateGuestPlayer reuses a same-name guest in owner scope", async () => {
  const admin = fakeAdmin([
    { id: "g1", email: "fam@x.nl", full_name: "Jan de Vries", academy_profile_id: "aca1" },
  ]);
  const res = await resolveOrCreateGuestPlayer(admin as unknown as SupabaseClient, {
    email: "Fam@x.nl",
    name: { first_name: "Jan", last_name: "de Vries", full_name: "Jan de Vries" },
    owner: { academyProfileId: "aca1" },
  });
  assertEquals(res.guestPlayerId, "g1");
  assertEquals(admin._inserted.length, 0);
  assertEquals(admin._updated.length, 1);
});

Deno.test("resolveOrCreateGuestPlayer does NOT overwrite phone when the booking omits it", async () => {
  const admin = fakeAdmin([
    { id: "g1", email: "fam@x.nl", full_name: "Jan de Vries", phone: "0612345678", academy_profile_id: "aca1" },
  ]);
  await resolveOrCreateGuestPlayer(admin as unknown as SupabaseClient, {
    email: "fam@x.nl",
    name: { first_name: "Jan", last_name: "de Vries", full_name: "Jan de Vries" },
    owner: { academyProfileId: "aca1" }, // no phone supplied
  });
  assertEquals(admin._updated.length, 1);
  assertEquals("phone" in admin._updated[0], false); // stored phone left intact
});

Deno.test("resolveOrCreateGuestPlayer DOES update phone when the booking supplies it", async () => {
  const admin = fakeAdmin([
    { id: "g1", email: "fam@x.nl", full_name: "Jan de Vries", phone: "0611111111", academy_profile_id: "aca1" },
  ]);
  await resolveOrCreateGuestPlayer(admin as unknown as SupabaseClient, {
    email: "fam@x.nl",
    name: { first_name: "Jan", last_name: "de Vries", full_name: "Jan de Vries" },
    phone: "0622222222",
    owner: { academyProfileId: "aca1" },
  });
  assertEquals(admin._updated[0].phone, "0622222222");
});

Deno.test("resolveOrCreateGuestPlayer creates a new row for a sibling (same email, different name)", async () => {
  const admin = fakeAdmin([
    { id: "g1", email: "fam@x.nl", full_name: "Jan de Vries", academy_profile_id: "aca1" },
  ]);
  const res = await resolveOrCreateGuestPlayer(admin as unknown as SupabaseClient, {
    email: "fam@x.nl",
    name: { first_name: "Sanne", last_name: "de Vries", full_name: "Sanne de Vries" },
    owner: { academyProfileId: "aca1" },
    source: "public_booking",
  });
  assertEquals(res.guestPlayerId, "new-1");
  assertEquals(admin._inserted.length, 1);
  assertEquals(admin._inserted[0].academy_profile_id, "aca1");
  assertEquals(admin._inserted[0].source, "public_booking");
});
