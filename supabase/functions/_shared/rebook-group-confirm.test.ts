import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { groupConfirmOk, type MemberConfirmStep, runGroupConfirmations } from "./rebook-group-confirm.ts";

// Codex round-5 #3: a post-send STAMP failure must NOT read as clean success. This is the regression
// that pins the exact requested semantics: stamp failure => unresolved=1, ok=false.
Deno.test("a stamp failure => sent counted, unresolved=1, ok=false (NOT clean success)", async () => {
  const tally = await runGroupConfirmations(["m1"], () => Promise.resolve("unresolved" as MemberConfirmStep));
  assertEquals(tally, { sent: 1, skipped: 0, failed: 0, unresolved: 1 });
  assertEquals(groupConfirmOk(tally), false);
});

Deno.test("a provider send failure => failed=1, ok=false", async () => {
  const tally = await runGroupConfirmations(["m1"], () => Promise.resolve("send_failed" as MemberConfirmStep));
  assertEquals(tally, { sent: 0, skipped: 0, failed: 1, unresolved: 0 });
  assertEquals(groupConfirmOk(tally), false);
});

Deno.test("every member sent+stamped => ok=true", async () => {
  const tally = await runGroupConfirmations(["m1", "m2"], () => Promise.resolve("sent" as MemberConfirmStep));
  assertEquals(tally, { sent: 2, skipped: 0, failed: 0, unresolved: 0 });
  assertEquals(groupConfirmOk(tally), true);
});

Deno.test("skipped-only (no verified email) is still ok — nothing was deliverable", async () => {
  const tally = await runGroupConfirmations(["m1"], () => Promise.resolve("skipped" as MemberConfirmStep));
  assertEquals(tally, { sent: 0, skipped: 1, failed: 0, unresolved: 0 });
  assertEquals(groupConfirmOk(tally), true);
});

Deno.test("mixed batch: each outcome tallied; ANY failed OR unresolved => ok=false", async () => {
  const steps: MemberConfirmStep[] = ["sent", "skipped", "send_failed", "unresolved", "sent"];
  const tally = await runGroupConfirmations(steps, (m) => Promise.resolve(m));
  assertEquals(tally, { sent: 3, skipped: 1, failed: 1, unresolved: 1 });
  assertEquals(groupConfirmOk(tally), false);
});

Deno.test("an empty group => zero tally, ok=true", async () => {
  const tally = await runGroupConfirmations([], () => Promise.resolve("sent" as MemberConfirmStep));
  assertEquals(tally, { sent: 0, skipped: 0, failed: 0, unresolved: 0 });
  assertEquals(groupConfirmOk(tally), true);
});
