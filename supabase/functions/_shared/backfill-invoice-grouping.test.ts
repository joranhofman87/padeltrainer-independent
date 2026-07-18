import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { backfillGroupKey, invoiceSubjectId } from "./backfill-invoice-grouping.ts";

Deno.test("invoiceSubjectId is GUEST-FIRST (FAM-02): a dual-key booking bills the guest", () => {
  // parent profile books for a child guest → subject is the guest, not the parent
  assertEquals(invoiceSubjectId({ player_id: "parent", guest_player_id: "child" }), "child");
  // pure profile booking → the profile
  assertEquals(invoiceSubjectId({ player_id: "p1", guest_player_id: null }), "p1");
  // pure guest booking → the guest
  assertEquals(invoiceSubjectId({ player_id: null, guest_player_id: "g1" }), "g1");
});

Deno.test("backfillGroupKey keeps two children of one parent in SEPARATE invoices", () => {
  const parent = "parent-profile";
  const k1 = backfillGroupKey("cyc1", { player_id: parent, guest_player_id: "childA" });
  const k2 = backfillGroupKey("cyc1", { player_id: parent, guest_player_id: "childB" });
  // profile-first grouping (the old bug) made these EQUAL ('cyc1__parent-profile'),
  // batching both children into one invoice subject.
  assertEquals(k1, "cyc1__childA");
  assertEquals(k2, "cyc1__childB");
  assertEquals(k1 === k2, false);
});

Deno.test("backfillGroupKey falls back to no-cycle for a null cyclus", () => {
  assertEquals(backfillGroupKey(null, { player_id: null, guest_player_id: "g1" }), "no-cycle__g1");
});
