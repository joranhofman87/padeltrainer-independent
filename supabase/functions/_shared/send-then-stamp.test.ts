import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runSendThenStamp, type SendStepOutcome, sendTallyOk, sendThenStampOne } from "./send-then-stamp.ts";

// sendThenStampOne — the SAFETY property Codex round-6 cares about: a failed send never stamps, so
// there is no permanent-suppression window.
Deno.test("sendThenStampOne: a failed send returns send_failed and NEVER calls stamp", async () => {
  let stampCalled = false;
  const r = await sendThenStampOne({
    send: () => Promise.resolve({ ok: false, error: "rejected" }),
    stamp: () => {
      stampCalled = true;
      return Promise.resolve({ error: null });
    },
  });
  assertEquals(r.outcome, "send_failed");
  assertEquals(r.error, "rejected");
  assertEquals(stampCalled, false); // no stamp on a failed send → the claim stays retryable, never suppressed
});

Deno.test("sendThenStampOne: send ok + stamp ok → sent", async () => {
  const r = await sendThenStampOne({ send: () => Promise.resolve({ ok: true }), stamp: () => Promise.resolve({ error: null }) });
  assertEquals(r.outcome, "sent");
});

Deno.test("sendThenStampOne: send ok + stamp ERROR → unresolved (NOT a clean skip)", async () => {
  const r = await sendThenStampOne({ send: () => Promise.resolve({ ok: true }), stamp: () => Promise.resolve({ error: { message: "db down" } }) });
  assertEquals(r.outcome, "unresolved");
});

Deno.test("sendThenStampOne: stamp:null (test/preview) → sent, stamp skipped", async () => {
  const r = await sendThenStampOne({ send: () => Promise.resolve({ ok: true }), stamp: null });
  assertEquals(r.outcome, "sent");
});

Deno.test("runSendThenStamp tallies each outcome and sendTallyOk = failed===0 && unresolved===0", async () => {
  const steps: SendStepOutcome[] = ["sent", "skipped", "send_failed", "unresolved", "sent"];
  const t = await runSendThenStamp(steps, (m) => Promise.resolve(m));
  assertEquals(t, { sent: 3, skipped: 1, failed: 1, unresolved: 1 });
  assertEquals(sendTallyOk(t), false); // any failed OR unresolved → not clean
  assertEquals(sendTallyOk({ sent: 2, skipped: 3, failed: 0, unresolved: 0 }), true); // skipped alone is fine
});
