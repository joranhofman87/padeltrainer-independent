import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";
import { canManageCycle, isAdminUser } from "./cycle-access.ts";

// These helpers back the auth gate on finalize-proposals and generate-proposals
// (both hold the service-role key, so they must authorize the caller in code).
// The functions take the supabase client as a parameter, so we stub the minimal
// query-builder chain they use: from(table).select(cols).eq(c,v)[.eq(c,v)].maybeSingle().

type Row = Record<string, unknown> | null;

function makeFakeSupabase(
  resolve: (table: string, filters: Record<string, unknown>) => Row,
) {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder = {
        select() {
          return builder;
        },
        eq(col: string, val: unknown) {
          filters[col] = val;
          return builder;
        },
        // deno-lint-ignore require-await
        async maybeSingle() {
          return { data: resolve(table, filters), error: null };
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

Deno.test("isAdminUser is true only when an admin user_roles row exists", async () => {
  const admin = makeFakeSupabase((table, f) =>
    table === "user_roles" && f.user_id === "u1" && f.role === "admin" ? { role: "admin" } : null
  );
  assertEquals(await isAdminUser(admin, "u1"), true);

  const notAdmin = makeFakeSupabase(() => null);
  assertEquals(await isAdminUser(notAdmin, "u1"), false);
});

Deno.test("canManageCycle: matching trainer owner can manage", async () => {
  const sb = makeFakeSupabase((table, f) =>
    table === "trainer_profiles" && f.user_id === "u1" && f.id === "own1" ? { id: "x" } : null
  );
  assertEquals(await canManageCycle(sb, "u1", { owner_type: "trainer", owner_id: "own1" }), true);
});

Deno.test("canManageCycle: non-owning user cannot manage a trainer cycle", async () => {
  const sb = makeFakeSupabase(() => null);
  assertEquals(await canManageCycle(sb, "u2", { owner_type: "trainer", owner_id: "own1" }), false);
});

Deno.test("canManageCycle: matching academy manager can manage", async () => {
  const sb = makeFakeSupabase((table, f) =>
    table === "academy_managers" && f.user_id === "u1" && f.academy_profile_id === "acad1"
      ? { id: "x" }
      : null
  );
  assertEquals(await canManageCycle(sb, "u1", { owner_type: "academy", owner_id: "acad1" }), true);
});

Deno.test("canManageCycle: academy manager of a different academy is denied (cross-tenant)", async () => {
  const sb = makeFakeSupabase((table, f) =>
    table === "academy_managers" && f.user_id === "u1" && f.academy_profile_id === "acadOWN"
      ? { id: "x" }
      : null
  );
  assertEquals(await canManageCycle(sb, "u1", { owner_type: "academy", owner_id: "acadOTHER" }), false);
});

Deno.test("canManageCycle: matching club manager can manage", async () => {
  const sb = makeFakeSupabase((table, f) =>
    table === "club_managers" && f.user_id === "u1" && f.club_profile_id === "club1" ? { id: "x" } : null
  );
  assertEquals(await canManageCycle(sb, "u1", { owner_type: "club", owner_id: "club1" }), true);
});

Deno.test("canManageCycle: unknown owner_type is denied without any DB lookup", async () => {
  // resolve always returns a row; the helper must still return false by short-circuiting.
  const sb = makeFakeSupabase(() => ({ id: "x" }));
  assertEquals(await canManageCycle(sb, "u1", { owner_type: "league", owner_id: "z" }), false);
});
