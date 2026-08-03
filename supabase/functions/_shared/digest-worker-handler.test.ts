import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runDigestWorkerHandler, type HandlerDeps } from "./digest-worker-handler.ts";
import { DigestWorkerError, type WorkerSummary } from "./digest-worker-core.ts";

const OK_SUMMARY: WorkerSummary = {
  status: "ok", sweptStale: 0, materialized: 0, claimed: 0, sent: 0, deferred: 0,
  oversizeSplit: 0, oversizeFailed: 0, recorded: 0, groupErrors: 0, reconcileErrors: 0,
  orphansExamined: 0, orphansLinked: 0, orphansQuarantined: 0, orphanErrors: 0, correlationMismatches: 0,
};

function harness(env: Record<string, string | undefined>, run: HandlerDeps["run"]) {
  const logs: Record<string, unknown>[] = [];
  const alerts: Record<string, unknown>[] = [];
  const runCalls: Array<{ resendApiKey: string; supabaseUrl: string; serviceKey: string }> = [];
  const deps: HandlerDeps = {
    env: (k) => env[k],
    log: (e) => logs.push(e),
    alert: (p) => { alerts.push(p); },
    run: (cfg) => { runCalls.push(cfg); return run(cfg); },
  };
  return { deps, logs, alerts, runCalls };
}

// SUPABASE_SERVICE_ROLE_KEY is the LEGACY service-role JWT (`eyJ…`), NOT a new-style sb_secret_ key — use an
// unmistakable JWT-shaped placeholder so this fixture can't re-teach the wrong key model.
const SR_JWT = "eyJhbGciOiJIUzI1NiJ9.SERVICE_ROLE_TEST_PLACEHOLDER.sig";
const CONFIGURED = { DIGEST_SEND_ENABLED: "true", RESEND_API_KEY: "re_x", SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: SR_JWT };

Deno.test("disabled (switch off): 200, run never invoked (ZERO DB), disabled log", async () => {
  const h = harness({ ...CONFIGURED, DIGEST_SEND_ENABLED: "false" }, () => Promise.resolve(OK_SUMMARY));
  const r = await runDigestWorkerHandler(h.deps);
  assertEquals(r.http, 200);
  assertEquals(r.status, "disabled");
  assertEquals(h.runCalls.length, 0);                // the worker (and every DB call) is never reached
  assert(h.logs.some((l) => l.event === "digest_worker_skipped" && l.reason === "disabled"));
});

Deno.test("switch unset entirely: treated as disabled, 200, zero run", async () => {
  const h = harness({ RESEND_API_KEY: "re_x", SUPABASE_URL: "u", SUPABASE_SERVICE_ROLE_KEY: "k" }, () => Promise.resolve(OK_SUMMARY));
  const r = await runDigestWorkerHandler(h.deps);
  assertEquals(r.http, 200);
  assertEquals(r.status, "disabled");
  assertEquals(h.runCalls.length, 0);
});

Deno.test("MISCONFIGURED (enabled, no RESEND_API_KEY): 500, run never invoked (ZERO DB), misconfigured log", async () => {
  const h = harness({ DIGEST_SEND_ENABLED: "true", SUPABASE_URL: "u", SUPABASE_SERVICE_ROLE_KEY: "k" }, () => Promise.resolve(OK_SUMMARY));
  const r = await runDigestWorkerHandler(h.deps);
  assertEquals(r.http, 500);                          // distinct from disabled — an alertable error
  assertEquals(r.status, "misconfigured");
  assertEquals(h.runCalls.length, 0);                // zero DB mutations on a misconfiguration
  const m = h.logs.find((l) => l.event === "digest_worker_misconfigured");
  assert(m && Array.isArray(m.missing) && (m.missing as string[]).includes("RESEND_API_KEY"));
  assertEquals(h.alerts.length, 1);                  // a real (best-effort) alert fired, once
  assertEquals(h.alerts[0].event, "digest_worker_misconfigured");
});

Deno.test("MISCONFIGURED (enabled, no Supabase service key): 500, zero run", async () => {
  const h = harness({ DIGEST_SEND_ENABLED: "true", RESEND_API_KEY: "re_x", SUPABASE_URL: "u" }, () => Promise.resolve(OK_SUMMARY));
  const r = await runDigestWorkerHandler(h.deps);
  assertEquals(r.http, 500);
  assertEquals(r.status, "misconfigured");
  assertEquals(h.runCalls.length, 0);
});

Deno.test("configured + healthy run: 200, run invoked exactly once, NO alert", async () => {
  const h = harness(CONFIGURED, () => Promise.resolve(OK_SUMMARY));
  const r = await runDigestWorkerHandler(h.deps);
  assertEquals(r.http, 200);
  assertEquals(r.status, "ok");
  assertEquals(h.runCalls.length, 1);
  assertEquals(h.runCalls[0], { resendApiKey: "re_x", supabaseUrl: "https://x.supabase.co", serviceKey: SR_JWT });
  assertEquals(h.alerts.length, 0);                  // a healthy run does NOT alert
});

Deno.test("configured + run reports 'error' (per-group failures): 500, ONE alert with safe counts", async () => {
  const h = harness(CONFIGURED, () => Promise.resolve({ ...OK_SUMMARY, status: "error", groupErrors: 2, claimed: 5, sent: 3, dispatchRunId: "run-abc" }));
  const r = await runDigestWorkerHandler(h.deps);
  assertEquals(r.http, 500);
  assertEquals(r.status, "error");
  assertEquals(h.alerts.length, 1);                  // exactly one alert per invocation (never per group)
  assertEquals(h.alerts[0].event, "digest_worker_run_failed");
  assertEquals(h.alerts[0].group_errors, 2);
  assertEquals(h.alerts[0].dispatch_run, "run-abc");
  // safe IDs/counts only — no PII markers
  assertEquals(JSON.stringify(h.alerts[0]).includes("@"), false);
});

Deno.test("configured + reconciliation-only error: 500, one alert carrying BOTH dispatch and materialize run IDs", async () => {
  const h = harness(CONFIGURED, () => Promise.resolve({ ...OK_SUMMARY, status: "error", groupErrors: 0, reconcileErrors: 1, dispatchRunId: "disp-9", materializeRunId: "mat-9", claimed: 1, sent: 1 }));
  const r = await runDigestWorkerHandler(h.deps);
  assertEquals(r.http, 500);
  assertEquals(h.alerts.length, 1);
  assertEquals(h.alerts[0].reason, "reconcile_errors");    // the reconcile failure is the cause
  assertEquals(h.alerts[0].dispatch_run, "disp-9");
  assertEquals(h.alerts[0].materialize_run, "mat-9");       // finding: materialize run id must be present too
  assertEquals(h.alerts[0].reconcile_errors, 1);
});

Deno.test("configured + run throws a plain Error: 500, one alert (no run context available)", async () => {
  const h = harness(CONFIGURED, () => Promise.reject(new Error("boom")));
  const r = await runDigestWorkerHandler(h.deps);
  assertEquals(r.http, 500);
  assertEquals(r.status, "error");
  assert(h.logs.some((l) => l.event === "digest_worker_invocation_error"));
  assertEquals(h.alerts.length, 1);
  assertEquals(h.alerts[0].event, "digest_worker_run_failed");
  assertEquals(h.alerts[0].dispatch_run, null);
});

Deno.test("configured + run throws a DigestWorkerError: the alert carries the safe run IDs + counts", async () => {
  const err = new DigestWorkerError(new Error("sweep exploded"), {
    status: "error", dispatchRunId: "disp-1", materializeRunId: "mat-1", groupErrors: 0, reconcileErrors: 1, claimed: 2, sent: 1,
  });
  const h = harness(CONFIGURED, () => Promise.reject(err));
  const r = await runDigestWorkerHandler(h.deps);
  assertEquals(r.http, 500);
  assertEquals(h.alerts.length, 1);
  assertEquals(h.alerts[0].dispatch_run, "disp-1");        // run id preserved on a THROWN failure (finding #2)
  assertEquals(h.alerts[0].materialize_run, "mat-1");
  assertEquals(h.alerts[0].reconcile_errors, 1);
  assertEquals(JSON.stringify(h.alerts[0]).includes("@"), false);
});

Deno.test("a THROWING alert cannot break the response (alert is best-effort)", async () => {
  // inject a misconfiguration AND an alert that throws — the handler must still return the 500, not throw.
  const logs: Record<string, unknown>[] = [];
  const deps: HandlerDeps = {
    env: (k) => ({ DIGEST_SEND_ENABLED: "true" } as Record<string, string | undefined>)[k],
    log: (e) => logs.push(e),
    alert: () => { throw new Error("slack down"); },
    run: () => Promise.resolve(OK_SUMMARY),
  };
  const r = await runDigestWorkerHandler(deps);
  assertEquals(r.http, 500);
  assertEquals(r.status, "misconfigured");
});

Deno.test("logs are PII-free: no email/html/token markers in any logged value", async () => {
  // drive every branch and scan the accumulated logs — the handler must only ever log events/reasons/missing.
  const cases: Record<string, string | undefined>[] = [
    { DIGEST_SEND_ENABLED: "false" },
    { DIGEST_SEND_ENABLED: "true", SUPABASE_URL: "u", SUPABASE_SERVICE_ROLE_KEY: "k" },
    { ...CONFIGURED },
  ];
  const all: Record<string, unknown>[] = [];
  for (const env of cases) {
    const h = harness(env, () => Promise.resolve(OK_SUMMARY));
    await runDigestWorkerHandler(h.deps);
    all.push(...h.logs);
  }
  const serialized = JSON.stringify(all);
  assert(!serialized.includes("@"), "no email-like value may be logged");
  assert(!serialized.includes("<"), "no html-like value may be logged");
  assert(!serialized.includes("re_x") && !serialized.includes("SERVICE_ROLE_TEST_PLACEHOLDER"), "no secret may be logged");
});

Deno.test("an ORPHAN-unhealthy run alerts on its own axis, with both counts", async () => {
  // Reporting an orphan failure as "reconcile_errors: 0" told the operator nothing about the
  // thing that actually needs them. The reason names the failing axis and the payload carries
  // both counts — including the quarantine, which is the item a human has to resolve.
  const h = harness(CONFIGURED, () => Promise.resolve({
    ...OK_SUMMARY, status: "error", orphanErrors: 2, orphansQuarantined: 1,
  }));
  const r = await runDigestWorkerHandler(h.deps);
  assertEquals(r.http, 500);
  assertEquals(h.alerts.length, 1);
  assertEquals(h.alerts[0].reason, "orphan_errors");
  assertEquals(h.alerts[0].orphan_errors, 2);
  assertEquals(h.alerts[0].orphans_quarantined, 1);
});

Deno.test("a group failure still outranks the orphan axis in the reason", async () => {
  const h = harness(CONFIGURED, () => Promise.resolve({
    ...OK_SUMMARY, status: "error", groupErrors: 1, orphanErrors: 1,
  }));
  await runDigestWorkerHandler(h.deps);
  assertEquals(h.alerts[0].reason, "group_errors");
  assertEquals(h.alerts[0].orphan_errors, 1, "...and the orphan count still travels");
});

Deno.test("a THROWN run keeps the orphan diagnostics — it is the only alert that fires", async () => {
  // A run can strand and quarantine a provider event and THEN throw on reconcile or finish.
  // Dropping the counts here hid the operator-required item behind a bare "invocation_error",
  // and a transient orphan error is backoff-deferred so the next invocation need not repeat it.
  const h = harness(CONFIGURED, () => Promise.reject(new DigestWorkerError("boom", {
    ...OK_SUMMARY, status: "error", orphanErrors: 1, orphansQuarantined: 1,
  })));
  const r = await runDigestWorkerHandler(h.deps);
  assertEquals(r.http, 500);
  assertEquals(h.alerts[0].reason, "invocation_error");
  assertEquals(h.alerts[0].orphan_errors, 1);
  assertEquals(h.alerts[0].orphans_quarantined, 1);
});
