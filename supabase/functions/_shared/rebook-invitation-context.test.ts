/* eslint-disable @typescript-eslint/no-explicit-any */
import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type InvitationDb, loadInvitationMetadata } from "./rebook-invitation-context.ts";

// A fake that satisfies InvitationDb. It honours `.range()` (offset) AND `.gt`/`.order`/`.limit`
// (keyset), because the group-claims read now pages by key: review round 1 pointed out that the
// previous fake treated every filter as a no-op and sliced a fixed array, so the 1,500-row
// assertion proved offset concatenation and nothing about paging a set that CHANGES mid-read —
// which is the only failure mode that read actually has.
//
// `mutate` lets a test remove rows between pages, which is exactly what a sibling answering does.
function fakeDb(config: {
  rows?: Record<string, unknown[]>;
  errors?: Record<string, { message: string }>;
  mutate?: (table: string, page: number, rows: unknown[]) => unknown[];
}): InvitationDb {
  const pageNo: Record<string, number> = {};
  return {
    from(table: string) {
      let rangeFrom: number | null = null;
      let rangeTo: number | null = null;
      let afterKey: string | null = null;
      const eqs: Array<[string, unknown]> = [];
      let ordered = false;
      let limit: number | null = null;
      // PostgREST silently caps a single select at ~1000 rows. The fake caps too — without it, a
      // loader that dropped pagination entirely would return all 1,500 in one call and the
      // "is NOT truncated" assertions would pass on the very defect they exist to catch (round 2).
      const SERVER_CAP = 1000;
      const build = () => {
        if (config.errors?.[table]) return { data: null, error: config.errors[table] };
        const n = (pageNo[table] = (pageNo[table] ?? 0) + 1);
        let rows = config.rows?.[table] ?? [];
        for (const [col, val] of eqs) {
          rows = rows.filter((r) => (r as Record<string, unknown>)[col] === val);
        }
        if (config.mutate) rows = config.mutate(table, n, rows);
        if (afterKey != null || ordered) {
          rows = [...rows].sort((a, b) =>
            String((a as { id?: string }).id) < String((b as { id?: string }).id) ? -1 : 1);
          if (afterKey != null) rows = rows.filter((r) => String((r as { id?: string }).id) > afterKey!);
          if (limit != null) rows = rows.slice(0, limit);
        } else if (rangeFrom != null) {
          rows = rows.slice(rangeFrom, (rangeTo ?? rows.length) + 1);
        }
        return { data: rows.slice(0, SERVER_CAP), error: null };
      };
      // deno-lint-ignore no-explicit-any
      const q: any = {
        select: () => q,
        in: () => q,
        // `.eq` FILTERS. It used to be a no-op, so dropping `status='pending'` from the loader was
        // invisible — and a declined sibling counted in the sender's series while the server's
        // one-statement aggregate excluded it, refusing the enqueue (round 2).
        eq: (col: string, val: unknown) => { eqs.push([col, val]); return q; },
        gt: (_c: string, v: unknown) => { afterKey = String(v); return q; },
        order: () => { ordered = true; return q; },
        limit: (n: number) => { limit = n; return q; },
        range: (f: number, t: number) => { rangeFrom = f; rangeTo = t; return q; },
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
  const gcRows = Array.from({ length: 1500 }, (_, i) => ({ id: `c${String(i).padStart(5, "0")}`, rebook_group_id: "grp1", player_id: "p1", guest_player_id: null, status: "pending", availability_slots: { start_time: `2026-08-${String((i % 27) + 1).padStart(2, "0")}T10:00:00Z` } }));
  const db = fakeDb({ rows: { availability_slots: oneSlot, academy_profiles: [], cycles: [{ id: "cy1", settings: {}, start_date: null }], slot_priority_claims: gcRows } });
  const meta = await loadInvitationMetadata(db, ["s1"], ["grp1"]);
  // PAIR-EXACT key (owner decision): the group plus BOTH identity columns, nulls included — the
  // scope `respond_to_priority_claim` books. It was `personKeyOf`, which is guest-first and would
  // have aggregated `(P, G)` together with `(NULL, G)`, describing a series the accept won't book.
  assertEquals(meta.groupInfo.get("grp1|p:p1|g:")?.sessions, 1500);
});


Deno.test("loadInvitationMetadata: a sibling answering MID-READ cannot skip a later session", async () => {
  // THE FAILURE OFFSETS HAVE AND KEYSET DOES NOT. `status='pending'` is a filter rows leave while
  // the read is running: a sibling clicking Accept between page one and page two removes an early
  // row, every later offset shifts down by one, and exactly one session is silently skipped. The
  // sender would then describe a shorter series than the server aggregates in one statement, and
  // the enqueue would refuse the invitation as changed.
  //
  // Here row `c00000` leaves the pending set after the first page. With keyset paging the cursor is
  // the last id seen, so the remaining rows are unaffected and the count is exact.
  const all = Array.from({ length: 1500 }, (_, i) => ({
    id: `c${String(i).padStart(5, "0")}`, rebook_group_id: "grp1", player_id: "p1",
    guest_player_id: null, status: "pending",
    availability_slots: { start_time: `2026-08-01T10:00:00Z` },
  }));
  const db = fakeDb({
    rows: {
      availability_slots: oneSlot, academy_profiles: [],
      cycles: [{ id: "cy1", settings: {}, start_date: null }],
      slot_priority_claims: all,
    },
    mutate: (table, page, rows) =>
      table === "slot_priority_claims" && page > 1
        ? (rows as { id: string }[]).filter((r) => r.id !== "c00000")
        : rows,
  });
  const meta = await loadInvitationMetadata(db, ["s1"], ["grp1"]);
  assertEquals(meta.groupInfo.get("grp1|p:p1|g:")?.sessions, 1500);
});

Deno.test("loadInvitationMetadata: a DECLINED sibling is not counted in the series", async () => {
  // The sender's count must equal what the server aggregates in one statement; the server filters
  // `status = 'pending'`. Before the fake honoured `.eq`, dropping that filter here was invisible —
  // and the mismatch shows up in production as an enqueue refused for a "changed" offer.
  const rows = [
    { id: "c1", rebook_group_id: "grp1", player_id: "p1", guest_player_id: null, status: "pending",
      availability_slots: { start_time: "2026-08-01T10:00:00Z" } },
    { id: "c2", rebook_group_id: "grp1", player_id: "p1", guest_player_id: null, status: "declined",
      availability_slots: { start_time: "2026-08-08T10:00:00Z" } },
  ];
  const db = fakeDb({
    rows: {
      availability_slots: oneSlot, academy_profiles: [],
      cycles: [{ id: "cy1", settings: {}, start_date: null }],
      slot_priority_claims: rows,
    },
  });
  const meta = await loadInvitationMetadata(db, ["s1"], ["grp1"]);
  assertEquals(meta.groupInfo.get("grp1|p:p1|g:")?.sessions, 1);
  assertEquals(meta.groupInfo.get("grp1|p:p1|g:")?.lastStart, "2026-08-01T10:00:00Z");
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
