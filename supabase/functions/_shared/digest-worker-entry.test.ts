import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { makeDigestWorkerEntry, type EntryDeps } from "./digest-worker-entry.ts";
import type { WorkerSummary } from "./digest-worker-core.ts";

const OK_SUMMARY: WorkerSummary = {
  status: "ok", sweptStale: 0, materialized: 0, claimed: 0, sent: 0, deferred: 0,
  oversizeSplit: 0, oversizeFailed: 0, recorded: 0, groupErrors: 0, reconcileErrors: 0,
  orphansExamined: 0, orphansLinked: 0, orphansQuarantined: 0, orphanErrors: 0, correlationMismatches: 0,
};
const CORS = { "Access-Control-Allow-Origin": "*" };
const CONFIGURED = { DIGEST_SEND_ENABLED: "true", RESEND_API_KEY: "re_x", SUPABASE_URL: "u", SUPABASE_SERVICE_ROLE_KEY: "k" };

// fake fail-closed auth: only "Bearer valid" passes; everything else (incl. no header, i.e. missing service
// secret) is rejected 401 — modelling requireServiceRole's real behaviour.
const fakeAuth = (req: Request): Response | null =>
  req.headers.get("authorization") === "Bearer valid" ? null : new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });

function harness(env: Record<string, string | undefined>, run: EntryDeps["run"]) {
  const alerts: Record<string, unknown>[] = [];
  const runCalls: unknown[] = [];
  const deps: EntryDeps = {
    env: (k) => env[k],
    requireServiceRole: fakeAuth,
    log: () => {},
    alert: (p) => { alerts.push(p); },
    run: (cfg) => { runCalls.push(cfg); return run(cfg); },
    corsHeaders: CORS,
  };
  return { entry: makeDigestWorkerEntry(deps), alerts, runCalls };
}
const authed = (b?: BodyInit) => new Request("https://x/fn", { method: "POST", headers: { authorization: "Bearer valid" }, body: b });
const unauthed = () => new Request("https://x/fn", { method: "POST" });

Deno.test("AUTH runs BEFORE config: an unauthenticated request is 401 even when misconfigured — run never called", async () => {
  // env is enabled-but-unconfigured (would be a handler 500) — but with no valid auth the entry must 401 FIRST,
  // never reaching config validation or the DB. This is the real endpoint contract (a missing service secret
  // surfaces as 401, not the handler's 500 'misconfigured').
  const h = harness({ DIGEST_SEND_ENABLED: "true" }, () => Promise.resolve(OK_SUMMARY));
  const res = await h.entry(unauthed());
  assertEquals(res.status, 401);
  assertEquals(h.runCalls.length, 0);
  assertEquals(h.alerts.length, 0);            // no alert on an auth rejection
});

Deno.test("authed + switch off → 200 disabled, run never called", async () => {
  const h = harness({ ...CONFIGURED, DIGEST_SEND_ENABLED: "false" }, () => Promise.resolve(OK_SUMMARY));
  const res = await h.entry(authed());
  assertEquals(res.status, 200);
  assertEquals((await res.json()).status, "disabled");
  assertEquals(h.runCalls.length, 0);
});

Deno.test("authed + misconfigured → 500 misconfigured + one alert (config gate reached only after auth)", async () => {
  const h = harness({ DIGEST_SEND_ENABLED: "true", RESEND_API_KEY: "re_x" }, () => Promise.resolve(OK_SUMMARY));
  const res = await h.entry(authed());
  assertEquals(res.status, 500);
  assertEquals((await res.json()).status, "misconfigured");
  assertEquals(h.runCalls.length, 0);
  assertEquals(h.alerts.length, 1);
});

Deno.test("authed + configured + healthy run → 200 ok", async () => {
  const h = harness(CONFIGURED, () => Promise.resolve(OK_SUMMARY));
  const res = await h.entry(authed());
  assertEquals(res.status, 200);
  assertEquals((await res.json()).status, "ok");
  assertEquals(h.runCalls.length, 1);
});

Deno.test("OPTIONS preflight → exactly 204 with CORS headers, no auth/run", async () => {
  const h = harness(CONFIGURED, () => Promise.resolve(OK_SUMMARY));
  const res = await h.entry(new Request("https://x/fn", { method: "OPTIONS" }));
  assertEquals(res.status, 204);                         // exact — not the default 200
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  assertEquals(h.runCalls.length, 0);
});
