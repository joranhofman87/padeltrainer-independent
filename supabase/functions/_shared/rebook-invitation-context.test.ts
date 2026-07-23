/* eslint-disable @typescript-eslint/no-explicit-any */
import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type InvitationDb, loadInvitationMetadata } from "./rebook-invitation-context.ts";

// A minimal fake that satisfies InvitationDb: configured rows per table, an optional per-table error,
// and .range()-based slicing so pagination is exercised. Filters (.in/.eq) are no-ops — the test
// controls the row set per table directly.
function fakeDb(config: { rows?: Record<string, unknown[]>; errors?: Record<string, { message: string }> }): InvitationDb {
  return {
    from(table: string) {
      let rangeFrom: number | null = null;
      let rangeTo: number | null = null;
      const build = () => {
        if (config.errors?.[table]) return { data: null, error: config.errors[table] };
        let rows = config.rows?.[table] ?? [];
        if (rangeFrom != null) rows = rows.slice(rangeFrom, (rangeTo ?? rows.length) + 1);
        return { data: rows, error: null };
      };
      // deno-lint-ignore no-explicit-any
      const q: any = {
        select: () => q,
        in: () => q,
        eq: () => q,
        range: (f: number, t: number) => {
          rangeFrom = f;
          rangeTo = t;
          return q;
        },
        then: (res: (v: { data: unknown; error: { message?: string } | null }) => unknown) => Promise.resolve(build()).then(res),
      };
      return q;
    },
  };
}

const oneSlot = [{ id: "s1", start_time: "2026-08-01T10:00:00Z", end_time: "2026-08-01T11:00:00Z", cyclus_id: "cy1", cyclus_name: "C", price_per_session: 10, priority_window_ends_at: null, academy_profile_id: "ac1" }];

Deno.test("loadInvitationMetadata: a SLOT read error throws (never marks every invite skipped)", async () => {
  const db = fakeDb({ errors: { availability_slots: { message: "slot boom" } } });
  await assertRejects(() => loadInvitationMetadata(db, ["s1"], []), Error, "slot read failed");
});

Deno.test("loadInvitationMetadata: an ACADEMY metadata read error throws", async () => {
  const db = fakeDb({ rows: { availability_slots: oneSlot }, errors: { academy_profiles: { message: "acad boom" } } });
  await assertRejects(() => loadInvitationMetadata(db, ["s1"], []), Error, "academy metadata read failed");
});

Deno.test("loadInvitationMetadata: a CYCLE metadata read error throws (never sends deferred copy for an upfront round)", async () => {
  const db = fakeDb({ rows: { availability_slots: oneSlot, academy_profiles: [{ id: "ac1", timezone: null, name: "A", business_name: null, contact_email: null, invoice_reply_to_email: null }] }, errors: { cycles: { message: "cycle boom" } } });
  await assertRejects(() => loadInvitationMetadata(db, ["s1"], []), Error, "cycle metadata read failed");
});

Deno.test("loadInvitationMetadata: a GROUP-CLAIMS read error throws (never describes a series as one session)", async () => {
  const db = fakeDb({ rows: { availability_slots: oneSlot, academy_profiles: [], cycles: [{ id: "cy1", settings: {}, start_date: null }] }, errors: { slot_priority_claims: { message: "gc boom" } } });
  await assertRejects(() => loadInvitationMetadata(db, ["s1"], ["g1"]), Error, "group-claims read failed");
});

Deno.test("loadInvitationMetadata: group-claims are PAGINATED — a 1500-session series is NOT truncated to 1000", async () => {
  const gcRows = Array.from({ length: 1500 }, (_, i) => ({ rebook_group_id: "grp1", player_id: "p1", guest_player_id: null, status: "pending", availability_slots: { start_time: `2026-08-${String((i % 27) + 1).padStart(2, "0")}T10:00:00Z` } }));
  const db = fakeDb({ rows: { availability_slots: oneSlot, academy_profiles: [], cycles: [{ id: "cy1", settings: {}, start_date: null }], slot_priority_claims: gcRows } });
  const meta = await loadInvitationMetadata(db, ["s1"], ["grp1"]);
  // personKeyOf({player_id:'p1', guest_player_id:null}) => 'p:p1'
  assertEquals(meta.groupInfo.get("grp1|p:p1")?.sessions, 1500);
});

Deno.test("loadInvitationMetadata: happy path assembles payment-mode + branding", async () => {
  const db = fakeDb({
    rows: {
      availability_slots: oneSlot,
      academy_profiles: [{ id: "ac1", timezone: "Europe/Amsterdam", name: "Acad", business_name: "Acad BV", contact_email: "hi@acad.nl", invoice_reply_to_email: null }],
      cycles: [{ id: "cy1", settings: { rebook_payment_mode: "upfront" }, start_date: "2026-09-01" }],
    },
  });
  const meta = await loadInvitationMetadata(db, ["s1"], []);
  assertEquals(meta.upfrontCycleIds.has("cy1"), true);
  assertEquals(meta.nameByAcademy.get("ac1"), "Acad BV");
  assertEquals(meta.replyToByAcademy.get("ac1"), "hi@acad.nl");
  assertEquals(meta.startDateByCycle.get("cy1"), "2026-09-01");
});
