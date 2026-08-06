// N4 M1 part 3 (Stage-3.5 AC-6) — the worker's INVOCATION CLAIM, in the worker itself.
//
// The RPC's semantics are proven in src/test/notifWorkerInvocations.realpg.test.ts; what lives
// here is the WIRING, because the first version of this checkpoint shipped the summary field
// without the call — the review that caught it noted execution went from run start straight to
// stale reconciliation. So these tests drive the REAL runDigestWorker with a fake rpc and pin:
//
//  1. the claim happens immediately after the dispatch run starts, BEFORE any pipeline
//     mutation — a run that will be refused must not have swept, materialized, claimed a group
//     or reached the provider first;
//  2. a claim REFUSAL (the RPC raises: duplicate request, foreign invocation) aborts the run:
//     finished 'failed', zero pipeline work, error propagated;
//  3. a claimed id reaches the summary; a 'none' claim (steady-state cron tick) changes nothing;
//  4. (round 5) the run claims with the invocation THE REQUEST NAMED, and a 'deferred' verdict —
//     this request names nothing while someone else's invocation is unresolved — does NO pipeline
//     work and finishes the run cleanly rather than failing it.
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { DigestWorkerError, runDigestWorker, type WorkerDeps, type WorkerSummary } from "./digest-worker-core.ts";

const DISPATCH_RUN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const INVOCATION = "11111111-2222-4333-8444-555555555555";

function deps(claimBehavior: "none" | "id" | "throw" | "deferred", requestInvocation: string | null = null) {
  const rpcCalls: string[] = [];
  const rpcArgs: Array<{ name: string; args: Record<string, unknown> }> = [];
  const d: WorkerDeps = {
    enabled: true,
    apiKeyPresent: true,
    channel: "email",
    from: "PadelTrainer <noreply@example.com>",
    limits: {
      maxMaterializeGroups: 10, maxMaterializeMembers: 50, maxAttempts: 3,
      sweepLimit: 10, orphanReconcileLimit: 10, wallClockMs: 60_000,
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push(name);
      rpcArgs.push({ name, args });
      switch (name) {
        case "start_notification_worker_run":
          return Promise.resolve(rpcCalls.filter((n) => n === "start_notification_worker_run").length === 1
            ? DISPATCH_RUN : "mmmmmmmm-mmmm-4mmm-8mmm-mmmmmmmmmmmm");
        case "claim_worker_invocation":
          if (claimBehavior === "throw") {
            return Promise.reject(new Error("claim_worker_invocation: invocation refused this run (…) — verdict conflict_other_run"));
          }
          // the REAL shape: one row from a RETURNS TABLE, as supabase-js hands it back
          return Promise.resolve(claimBehavior === "id"
            ? [{ status: "owned", invocation_id: INVOCATION }]
            : [{ status: claimBehavior === "deferred" ? "deferred" : "none", invocation_id: null }]);
        case "reconcile_notification_digest_stale": return Promise.resolve(0);
        case "materialize_notification_digest_groups": return Promise.resolve(0);
        case "claim_notification_digest_group": return Promise.resolve(null);
        case "reconcile_orphan_provider_events":
          return Promise.resolve([{ examined: 0, linked: 0, quarantined: 0, errors: 0 }]);
        default: return Promise.resolve(null);
      }
    },
    readGroupState: () => Promise.resolve("request_ready"),
    loadMembers: () => Promise.resolve([]),
    loadFrozen: () => Promise.resolve({
      request: { from: "PadelTrainer <noreply@example.com>", to: "p@example.com", subject: "s", html: "<p>h</p>" },
      idempotencyKey: "dg:v1:key",
    }),
    reconcile: () => Promise.resolve([]),
    sendOnce: () => Promise.resolve({
      kind: "response" as const,
      httpStatus: 200,
      errorName: null,
      providerMessageId: "resend-msg",
      retryAfterSeconds: null,
    }),
    now: () => new Date("2026-08-03T12:00:00Z"),
    monotonicNowMs: () => 0,
    newToken: () => "token-1",
    invocationId: requestInvocation,
    log: () => {},
  };
  return { d, rpcCalls, rpcArgs };
}

const PIPELINE_RPCS = [
  "reconcile_notification_digest_stale",
  "materialize_notification_digest_groups",
  "claim_notification_digest_group",
  "begin_notification_digest_attempt",
  "record_notification_digest_result",
];

Deno.test("the claim is the FIRST thing after the dispatch run starts — before any pipeline mutation", async () => {
  const { d, rpcCalls } = deps("id");
  const s: WorkerSummary = await runDigestWorker(d);
  assertEquals(s.invocationId, INVOCATION);
  const claimIdx = rpcCalls.indexOf("claim_worker_invocation");
  assert(claimIdx >= 0, "the worker never called claim_worker_invocation");
  assertEquals(rpcCalls[claimIdx - 1], "start_notification_worker_run",
    "the claim must come immediately after the dispatch run start");
  for (const p of PIPELINE_RPCS) {
    const i = rpcCalls.indexOf(p);
    assert(i === -1 || i > claimIdx, `${p} ran BEFORE the invocation claim`);
  }
});

Deno.test("...and it claims with the run it just started AND the invocation the REQUEST named", async () => {
  const { d, rpcArgs } = deps("id", INVOCATION);
  await runDigestWorker(d);
  const call = rpcArgs.find((r) => r.name === "claim_worker_invocation");
  assertEquals(call?.args.p_worker_run_id, DISPATCH_RUN);
  // round 5: the identity comes from the request body, never from a search for "the unresolved
  // one" — that search is what let an unrelated in-flight tick bind a canary's evidence
  assertEquals(call?.args.p_invocation_id, INVOCATION);
});

Deno.test("a request that names NOTHING passes null — it can never own an invocation", async () => {
  const { d, rpcArgs } = deps("none");
  await runDigestWorker(d);
  const call = rpcArgs.find((r) => r.name === "claim_worker_invocation");
  assertEquals(call?.args.p_invocation_id, null);
});

Deno.test("DEFERRED: no pipeline work, run finished CLEANLY, and the summary says so", async () => {
  const { d, rpcCalls, rpcArgs } = deps("deferred");
  const s: WorkerSummary = await runDigestWorker(d);
  assertEquals(s.invocationDeferred, true);
  assertEquals(s.status, "ok");            // nothing failed — the deliberate request is still coming
  assertEquals(s.invocationId, undefined);
  for (const p of PIPELINE_RPCS) {
    assertEquals(rpcCalls.includes(p), false, `${p} ran inside someone else's evidence window`);
  }
  const finish = rpcArgs.filter((r) => r.name === "finish_notification_worker_run" && r.args.p_run_id === DISPATCH_RUN);
  assertEquals(finish.map((r) => r.args.p_status), ["succeeded"]);
});

Deno.test("a DEFERRED run whose RECONCILE fails is NOT a green 200 — the run is failed, so the status is too", async () => {
  const { d } = deps("deferred");
  const bad: WorkerDeps = { ...d, reconcile: () => Promise.reject(new Error("reconcile down")) };
  const s: WorkerSummary = await runDigestWorker(bad);
  assertEquals(s.invocationDeferred, true);
  assertEquals(s.status, "error");           // 500 + alert, not a quiet success
  assertEquals(s.reconcileErrors, 1);
});

Deno.test("an UNREADABLE claim result is a refusal, never a silent steady-state pass", async () => {
  const { d, rpcCalls } = deps("none");
  const bad: WorkerDeps = { ...d, rpc: (name, args) => name === "claim_worker_invocation"
    ? Promise.resolve([{ status: "surprise" }]) : d.rpc(name, args) };
  await assertRejects(() => runDigestWorker(bad), DigestWorkerError);
  for (const p of PIPELINE_RPCS) {
    assertEquals(rpcCalls.includes(p), false, `${p} ran on an unreadable claim result`);
  }
});

Deno.test("a claim REFUSAL aborts the run: finished 'failed', ZERO pipeline work, error propagated", async () => {
  const { d, rpcCalls, rpcArgs } = deps("throw");
  const err = await assertRejects(() => runDigestWorker(d), DigestWorkerError);
  assert(String(err.message).includes("conflict_other_run"), "the original refusal must survive the wrap");
  for (const p of PIPELINE_RPCS) {
    assertEquals(rpcCalls.includes(p), false, `${p} ran despite the refused claim`);
  }
  const finish = rpcArgs.filter((r) => r.name === "finish_notification_worker_run" && r.args.p_run_id === DISPATCH_RUN);
  assertEquals(finish.map((r) => r.args.p_status), ["failed"]);
});

Deno.test("a 'none' claim is the steady-state tick: the pipeline proceeds and the summary carries no invocation", async () => {
  const { d, rpcCalls } = deps("none");
  const s: WorkerSummary = await runDigestWorker(d);
  assertEquals(s.invocationId, undefined);
  assertEquals(s.status, "ok");
  assert(rpcCalls.includes("reconcile_notification_digest_stale"), "steady-state must still sweep");
});
