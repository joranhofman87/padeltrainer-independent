// 10c-b G — a CORRELATION MISMATCH must not finish as a healthy run.
//
// record_notification_digest_result writes the attempt row as `accepted` (20261004100000:1038)
// BEFORE it tests whether the group is already bound to a DIFFERENT provider message (:1091). On a
// mismatch it trips the breaker with reason 'correlation_mismatch' and retry_at NULL — a MANUAL
// HOLD that no backoff ever clears — and reports it by RETURNING 'correlation_mismatch'.
//
// The worker used to discard that return. The attempt read `accepted`, the group was counted as
// sent, and the run finished `succeeded`: once the cron is armed it would go on ticking green,
// every five minutes, while email was held open and nothing was being delivered.
//
// These tests drive the REAL runDigestWorker with a fake rpc, because the defect lives in what the
// worker does with a return value — a handler-level test with `run` stubbed cannot see it.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { DigestWorkerError, runDigestWorker, type WorkerDeps, type WorkerSummary } from "./digest-worker-core.ts";
import { runDigestWorkerHandler, type HandlerDeps } from "./digest-worker-handler.ts";

const GROUP = "gggggggg-gggg-4ggg-8ggg-gggggggggggg";
const ATTEMPT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DISPATCH_RUN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

/** A worker whose single claimed group is already `request_ready`, so the run reaches exactly one
 *  send and one record. `recordReturns` is what record_notification_digest_result answers with. */
function deps(recordReturns: unknown, opts: { httpStatus?: number } = {}) {
  const logs: Record<string, unknown>[] = [];
  const rpcCalls: string[] = [];
  // ARGUMENTS, not just names. Counting calls would let the worker return status "error" while
  // finishing the run 'succeeded' in the ledger — the summary and the durable record disagreeing is
  // exactly what the preflight later reads, so the persisted status is the thing worth asserting.
  const rpcArgs: Array<{ name: string; args: Record<string, unknown> }> = [];
  let claimed = false;
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
        case "reconcile_notification_digest_stale": return Promise.resolve(0);
        case "materialize_notification_digest_groups": return Promise.resolve(0);
        case "claim_notification_digest_group":
          if (claimed) return Promise.resolve(null);
          claimed = true;
          return Promise.resolve(GROUP);
        case "begin_notification_digest_attempt": return Promise.resolve(ATTEMPT);
        case "record_notification_digest_result": return Promise.resolve(recordReturns);
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
    // `kind: "response"` — the discriminant the real ResendSendOnceResult uses. An invented one
    // ("http") type-checked only because it was cast, and still reached the right branch by falling
    // through the `!== "transport"` else — a fixture that violates a production invariant passing
    // for the wrong reason, which is the trap this suite has paid for repeatedly. No cast now, so
    // the compiler checks the shape.
    sendOnce: () => Promise.resolve({
      kind: "response" as const,
      httpStatus: opts.httpStatus ?? 200,
      errorName: null,
      providerMessageId: "resend-msg-THE-NEW-ONE",
      retryAfterSeconds: null,
    }),
    now: () => new Date("2026-08-03T12:00:00Z"),
    monotonicNowMs: () => 0,
    newToken: () => "token-1",
    log: (e) => logs.push(e),
  };
  return { d, logs, rpcCalls, rpcArgs };
}

/** The status the DISPATCH run was actually finished with, as persisted. */
const dispatchFinishStatus = (rpcArgs: Array<{ name: string; args: Record<string, unknown> }>) =>
  rpcArgs.filter((r) => r.name === "finish_notification_worker_run" && r.args.p_run_id === DISPATCH_RUN)
    .map((r) => r.args.p_status);

Deno.test("a correlation mismatch makes the RUN unhealthy (not a green 200)", async () => {
  const { d, rpcArgs } = deps("correlation_mismatch");
  const s: WorkerSummary = await runDigestWorker(d);
  assertEquals(s.correlationMismatches, 1);
  assertEquals(s.status, "error");            // <- the whole point: not "ok"
  // ...and the LEDGER says so. A summary of "error" over a run finished 'succeeded' would still
  // leave notif_digest_worker_liveness() and the activation preflight reading a healthy run.
  assertEquals(dispatchFinishStatus(rpcArgs), ["failed"]);
});

Deno.test("a correlation mismatch is NOT counted as a send", async () => {
  const { d } = deps("correlation_mismatch");
  const s = await runDigestWorker(d);
  // The provider accepted a message this group is not bound to. Counting it would report a
  // delivery that can never be reconciled to anything.
  assertEquals(s.sent, 0);
  assertEquals(s.recorded, 1);                // it WAS recorded — the attempt row exists
});

Deno.test("a clean accepted outcome still finishes healthy and counts as sent", async () => {
  // Without this, "status is error" could be satisfied by the run failing for some unrelated
  // reason, and the mismatch tests above would pass while proving nothing.
  const { d, rpcArgs } = deps("accepted");
  const s = await runDigestWorker(d);
  assertEquals(s.correlationMismatches, 0);
  assertEquals(s.status, "ok");
  assertEquals(s.sent, 1);
  assertEquals(dispatchFinishStatus(rpcArgs), ["succeeded"]);
});

Deno.test("the outcome is read from any shape a scalar RPC returns", async () => {
  for (const shape of ["correlation_mismatch", ["correlation_mismatch"],
                       [{ record_notification_digest_result: "correlation_mismatch" }],
                       { record_notification_digest_result: "correlation_mismatch" }]) {
    const { d } = deps(shape);
    const s = await runDigestWorker(d);
    assertEquals(s.correlationMismatches, 1, `shape ${JSON.stringify(shape)} was not read`);
    assertEquals(s.status, "error");
  }
});

Deno.test("an UNREADABLE outcome is unhealthy too, and is not counted as a mismatch", async () => {
  // If the recorded class cannot be read we cannot say the send correlated. Assuming it was clean
  // is the exact failure mode this slice closed, so it counts as a group error instead.
  const { d, logs } = deps(null);
  const s = await runDigestWorker(d);
  assertEquals(s.correlationMismatches, 0);   // we do not claim a mismatch we did not observe
  assertEquals(s.groupErrors, 1);
  assertEquals(s.status, "error");
  assertEquals(s.sent, 0);
  assert(logs.some((l) => l.event === "attempt_outcome_unreadable"));
});

Deno.test("a NON-2xx outcome is unaffected by the mismatch check", async () => {
  const { d } = deps("ambiguous", { httpStatus: 500 });
  const s = await runDigestWorker(d);
  assertEquals(s.correlationMismatches, 0);
  assertEquals(s.sent, 0);
  assertEquals(s.status, "ok");               // ambiguous is a retry, not a run failure
});

// ── the alert must NAME the axis, or an operator learns nothing ──────────────
function alertHarness(summary: WorkerSummary) {
  const alerts: Record<string, unknown>[] = [];
  const deps: HandlerDeps = {
    env: (k) => ({
      DIGEST_SEND_ENABLED: "true", RESEND_API_KEY: "re_x", SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "eyJhbGciOiJIUzI1NiJ9.SERVICE_ROLE_TEST_PLACEHOLDER.sig",
    } as Record<string, string>)[k],
    log: () => {},
    alert: (p) => { alerts.push(p); },
    run: () => Promise.resolve(summary),
  };
  return { deps, alerts };
}

const BASE: WorkerSummary = {
  status: "error", sweptStale: 0, materialized: 0, claimed: 1, sent: 0, deferred: 0,
  oversizeSplit: 0, oversizeFailed: 0, recorded: 1, groupErrors: 0, reconcileErrors: 0,
  orphansExamined: 0, orphansLinked: 0, orphansQuarantined: 0, orphanErrors: 0, correlationMismatches: 1,
};

Deno.test("the alert reason is correlation_mismatch, not reconcile_errors", async () => {
  // A manual hold reported as "reconcile_errors: 0" is the mislabelling the reason chain exists to
  // prevent — and it is what a mismatch produced before it had its own arm.
  const h = alertHarness(BASE);
  const r = await runDigestWorkerHandler(h.deps);
  assertEquals(r.http, 500);
  assertEquals(h.alerts.length, 1);
  assertEquals(h.alerts[0].reason, "correlation_mismatch");
  assertEquals(h.alerts[0].correlation_mismatches, 1);
});

Deno.test("a correlation mismatch OUTRANKS a group error in the alert reason", async () => {
  // Both can be true at once; the manual hold is the one that needs a human, so it must win.
  const h = alertHarness({ ...BASE, groupErrors: 2 });
  await runDigestWorkerHandler(h.deps);
  assertEquals(h.alerts[0].reason, "correlation_mismatch");
});

Deno.test("without a mismatch the existing reasons are unchanged", async () => {
  const h = alertHarness({ ...BASE, correlationMismatches: 0, groupErrors: 2 });
  await runDigestWorkerHandler(h.deps);
  assertEquals(h.alerts[0].reason, "group_errors");
});

// ── the THROW path must not lose the precedence ──────────────────────────────
// If the next claim, or the final finish, fails after a mismatch has already opened its manual
// hold, this is the ONLY alert that fires. Reporting it as "invocation_error" hides the one cause
// that needs a human.
function throwingHarness(summary: Partial<WorkerSummary>) {
  const alerts: Record<string, unknown>[] = [];
  const deps: HandlerDeps = {
    env: (k) => ({
      DIGEST_SEND_ENABLED: "true", RESEND_API_KEY: "re_x", SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "eyJhbGciOiJIUzI1NiJ9.SERVICE_ROLE_TEST_PLACEHOLDER.sig",
    } as Record<string, string>)[k],
    log: () => {},
    alert: (p) => { alerts.push(p); },
    run: () => Promise.reject(new DigestWorkerError(new Error("finish failed"), summary)),
  };
  return { deps, alerts };
}

Deno.test("a mismatch followed by a THROWN failure still alerts as correlation_mismatch", async () => {
  const h = throwingHarness({ dispatchRunId: DISPATCH_RUN, correlationMismatches: 1, groupErrors: 0 });
  const r = await runDigestWorkerHandler(h.deps);
  assertEquals(r.http, 500);
  assertEquals(h.alerts.length, 1);
  assertEquals(h.alerts[0].reason, "correlation_mismatch");
  assertEquals(h.alerts[0].correlation_mismatches, 1);
});

Deno.test("a thrown failure with NO failing axis still reads invocation_error", async () => {
  const h = throwingHarness({ dispatchRunId: DISPATCH_RUN, correlationMismatches: 0 });
  await runDigestWorkerHandler(h.deps);
  assertEquals(h.alerts[0].reason, "invocation_error");
});

// The thrown path used to answer "invocation_error" for EVERY axis, not just this one. Both paths
// now share digestAlertReason, so each axis is named wherever it is reported from.
Deno.test("the thrown path names a group failure too", async () => {
  const h = throwingHarness({ dispatchRunId: DISPATCH_RUN, groupErrors: 3 });
  await runDigestWorkerHandler(h.deps);
  assertEquals(h.alerts[0].reason, "group_errors");
});

Deno.test("the thrown path names a quarantined orphan too", async () => {
  const h = throwingHarness({ dispatchRunId: DISPATCH_RUN, orphanErrors: 1, orphansQuarantined: 1 });
  await runDigestWorkerHandler(h.deps);
  assertEquals(h.alerts[0].reason, "orphan_errors");
});

Deno.test("the thrown path names a reconcile failure too", async () => {
  const h = throwingHarness({ dispatchRunId: DISPATCH_RUN, reconcileErrors: 2 });
  await runDigestWorkerHandler(h.deps);
  assertEquals(h.alerts[0].reason, "reconcile_errors");
});

// One rule, so the two paths cannot drift apart again.
Deno.test("both paths agree on the reason for the same summary", async () => {
  for (const s of [
    { correlationMismatches: 1 }, { groupErrors: 1 }, { orphanErrors: 1, orphansQuarantined: 1 },
    { reconcileErrors: 1 }, { groupErrors: 1, orphanErrors: 1 },
  ]) {
    const thrown = throwingHarness({ dispatchRunId: DISPATCH_RUN, ...s });
    await runDigestWorkerHandler(thrown.deps);
    const returned = alertHarness({ ...BASE, correlationMismatches: 0, ...s });
    await runDigestWorkerHandler(returned.deps);
    assertEquals(thrown.alerts[0].reason, returned.alerts[0].reason,
      `the two paths disagree for ${JSON.stringify(s)}`);
  }
});
