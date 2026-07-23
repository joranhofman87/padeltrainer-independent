import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { gateGroupConfirmation, groupConfirmOk, type MemberConfirmStep, runGroupConfirmations } from "./rebook-group-confirm.ts";

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
// Codex round-9 #3/#4: the admission ordering (cheap probe → consume → expensive scan) must hold, so a
// throttled/no-work call never runs the full scan and a no-work call never consumes an allowance.
Deno.test("gate: no work → no consume, no scan", async () => {
  let consumed = false, scanned = false;
  const r = await gateGroupConfirmation<number>({
    hasWork: () => Promise.resolve(false),
    consumeAllowance: () => { consumed = true; return Promise.resolve(true); },
    scan: () => { scanned = true; return Promise.resolve([]); },
  });
  assertEquals(r.kind, "no_work");
  assertEquals(consumed, false); // a benign no-work retry must not burn the allowance
  assertEquals(scanned, false);
});

Deno.test("gate: throttled → consumed but the expensive scan NEVER runs", async () => {
  let scanned = false;
  const r = await gateGroupConfirmation<number>({
    hasWork: () => Promise.resolve(true),
    consumeAllowance: () => Promise.resolve(false), // over the limit
    scan: () => { scanned = true; return Promise.resolve([1, 2, 3]); },
  });
  assertEquals(r.kind, "throttled");
  assertEquals(scanned, false); // a throttled token can't force repeated expensive scans
});

Deno.test("gate: work + allowance → ready with the scanned claims", async () => {
  const order: string[] = [];
  const r = await gateGroupConfirmation<number>({
    hasWork: () => { order.push("probe"); return Promise.resolve(true); },
    consumeAllowance: () => { order.push("consume"); return Promise.resolve(true); },
    scan: () => { order.push("scan"); return Promise.resolve([1, 2]); },
  });
  assertEquals(r.kind === "ready" ? r.claims : null, [1, 2]);
  assertEquals(order, ["probe", "consume", "scan"]); // probe BEFORE consume BEFORE scan
});
