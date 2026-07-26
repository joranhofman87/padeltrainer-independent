import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runDigestWorkerHandler, type HandlerDeps } from "./digest-worker-handler.ts";
import type { WorkerSummary } from "./digest-worker-core.ts";

const OK_SUMMARY: WorkerSummary = {
  status: "ok", sweptStale: 0, materialized: 0, claimed: 0, sent: 0, deferred: 0,
  oversizeSplit: 0, oversizeFailed: 0, recorded: 0, groupErrors: 0,
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

const CONFIGURED = { DIGEST_SEND_ENABLED: "true", RESEND_API_KEY: "re_x", SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_x" };

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
  assertEquals(h.runCalls[0], { resendApiKey: "re_x", supabaseUrl: "https://x.supabase.co", serviceKey: "sb_secret_x" });
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

Deno.test("configured + run throws (run-level failure): 500, invocation-error log + ONE alert", async () => {
  const h = harness(CONFIGURED, () => Promise.reject(new Error("boom")));
  const r = await runDigestWorkerHandler(h.deps);
  assertEquals(r.http, 500);
  assertEquals(r.status, "error");
  assert(h.logs.some((l) => l.event === "digest_worker_invocation_error"));
  assertEquals(h.alerts.length, 1);
  assertEquals(h.alerts[0].event, "digest_worker_run_failed");
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
  assert(!serialized.includes("re_x") && !serialized.includes("sb_secret"), "no secret may be logged");
});
