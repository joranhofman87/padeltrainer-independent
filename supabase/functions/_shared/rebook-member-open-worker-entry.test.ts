// D7 — the dispatcher's endpoint policy: the status matrix, the OD-3 activation flag, and the
// ZERO-DATABASE-CALL property of a disabled invocation.
//
// The flag test is the one that matters most: it is the only thing standing between a deployed
// function and a live send, so it is exercised on every plausible spelling of "on" and on the
// ordering that puts auth in front of it.
import { assert, assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import {
  makeRebookMemberOpenWorkerEntry,
  REBOOK_MEMBER_OPEN_SEND_FLAG,
  runRebookMemberOpenWorkerHandler,
} from "./rebook-member-open-worker-entry.ts";
import type { WorkerSummary } from "./rebook-member-open-worker-core.ts";

const CORS = { "Access-Control-Allow-Origin": "*" };

const summary = (over: Partial<WorkerSummary> = {}): WorkerSummary => ({
  status: "ok",
  workerToken: "t",
  claimed: 0,
  unprocessed: 0,
  authorized: 0,
  observed: 0,
  recorded: 0,
  deferred: 0,
  held: 0,
  terminalRetained: 0,
  terminalDeleted: 0,
  refused: 0,
  rowErrors: 0,
  ...over,
});

const FULL_ENV: Record<string, string> = {
  [REBOOK_MEMBER_OPEN_SEND_FLAG]: "true",
  RESEND_API_KEY: "re_x",
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "sr",
};

function harness(env: Record<string, string>, run?: () => Promise<WorkerSummary>) {
  const state = { ran: 0, alerts: [] as Record<string, unknown>[], logs: [] as Record<string, unknown>[] };
  const deps = {
    env: (k: string) => env[k],
    log: (e: Record<string, unknown>) => state.logs.push(e),
    alert: (p: Record<string, unknown>) => { state.alerts.push(p); },
    run: () => {
      state.ran += 1;
      return run ? run() : Promise.resolve(summary());
    },
  };
  return { deps, state };
}

// ── The flag ──────────────────────────────────────────────────────────────────────────────────

Deno.test("the flag is ABSENT by default: disabled, 200, and ZERO database calls", async () => {
  const { deps, state } = harness({ ...FULL_ENV, [REBOOK_MEMBER_OPEN_SEND_FLAG]: "" });
  const r = await runRebookMemberOpenWorkerHandler(deps);
  assertEquals(r.http, 200);
  assertEquals(r.status, "disabled");
  assertEquals(state.ran, 0, "a disabled invocation must not reach the worker at all");
  assertEquals(state.alerts.length, 0, "a healthy no-op is not an alert");
});

Deno.test("an env with the flag key wholly missing is disabled", async () => {
  const env = { ...FULL_ENV };
  delete env[REBOOK_MEMBER_OPEN_SEND_FLAG];
  const { deps, state } = harness(env);
  assertEquals((await runRebookMemberOpenWorkerHandler(deps)).status, "disabled");
  assertEquals(state.ran, 0);
});

Deno.test("only the exact string \"true\" enables — every near-miss stays OFF", async () => {
  for (const value of ["TRUE", "True", "1", "yes", "on", " true", "true ", "truthy", "0", "false"]) {
    const { deps, state } = harness({ ...FULL_ENV, [REBOOK_MEMBER_OPEN_SEND_FLAG]: value });
    const r = await runRebookMemberOpenWorkerHandler(deps);
    assertEquals(r.status, "disabled", `${JSON.stringify(value)} must not enable sending`);
    assertEquals(state.ran, 0);
  }
});

Deno.test("the exact string \"true\" is the one arm that runs the worker", async () => {
  const { deps, state } = harness(FULL_ENV);
  const r = await runRebookMemberOpenWorkerHandler(deps);
  assertEquals(r.http, 200);
  assertEquals(r.status, "ok");
  assertEquals(state.ran, 1);
});

// ── Config ────────────────────────────────────────────────────────────────────────────────────

Deno.test("enabled but unconfigured: 500 misconfigured, ZERO database calls, one alert", async () => {
  for (const missing of ["RESEND_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    const env = { ...FULL_ENV };
    delete env[missing];
    const { deps, state } = harness(env);
    const r = await runRebookMemberOpenWorkerHandler(deps);
    assertEquals(r.http, 500);
    assertEquals(r.status, "misconfigured");
    assertEquals(state.ran, 0);
    assertEquals(state.alerts.length, 1);
    assertEquals((state.alerts[0].missing as string[])[0], missing);
  }
});

Deno.test("the disabled arm is checked BEFORE config — an unconfigured, disabled function is quiet", async () => {
  const { deps, state } = harness({ [REBOOK_MEMBER_OPEN_SEND_FLAG]: "false" });
  const r = await runRebookMemberOpenWorkerHandler(deps);
  assertEquals(r.status, "disabled");
  assertEquals(state.alerts.length, 0, "an inert function must not page anyone about config");
});

// ── Run outcomes ──────────────────────────────────────────────────────────────────────────────

Deno.test("a red run is 500 and alerts once with counts only", async () => {
  const { deps, state } = harness(
    FULL_ENV,
    () => Promise.resolve(summary({ status: "error", rowErrors: 2, claimed: 3, observed: 1 })),
  );
  const r = await runRebookMemberOpenWorkerHandler(deps);
  assertEquals(r.http, 500);
  assertEquals(r.status, "error");
  assertEquals(state.alerts.length, 1);
  assertEquals(state.alerts[0].row_errors, 2);
});

Deno.test("a THROWN run is 500 and NOTHING from the thrown value reaches the response", async () => {
  const secret = "postgres://user:hunter2@db.internal/app";
  const { deps, state } = harness(FULL_ENV, () => Promise.reject(new Error(secret)));
  const r = await runRebookMemberOpenWorkerHandler(deps);
  assertEquals(r.http, 500);
  assertEquals(r.body, { status: "error" });
  const serialized = JSON.stringify({ body: r.body, alerts: state.alerts, logs: state.logs });
  assert(!serialized.includes("hunter2"), "no thrown text may reach the response, alert or log");
});

Deno.test("a THROWING alert cannot break or mask the primary response", async () => {
  const deps = {
    env: (k: string) => FULL_ENV[k],
    log: () => {},
    alert: () => { throw new Error("slack down"); },
    run: () => Promise.resolve(summary({ status: "error" })),
  };
  assertEquals((await runRebookMemberOpenWorkerHandler(deps)).http, 500);
});

// ── The entry: ordering and the absent body read ──────────────────────────────────────────────

Deno.test("OPTIONS is 204 before anything else", async () => {
  let authCalls = 0;
  const entry = makeRebookMemberOpenWorkerEntry({
    env: (k) => FULL_ENV[k],
    requireServiceRole: () => { authCalls += 1; return null; },
    log: () => {},
    alert: () => {},
    run: () => Promise.resolve(summary()),
    corsHeaders: CORS,
  });
  const res = await entry(new Request("https://x/", { method: "OPTIONS" }));
  assertEquals(res.status, 204);
  assertEquals(authCalls, 0);
});

Deno.test("AUTH RUNS FIRST: a 401 happens before the flag, config or any run", async () => {
  let envReads = 0;
  let ran = 0;
  const entry = makeRebookMemberOpenWorkerEntry({
    env: (k) => { envReads += 1; return FULL_ENV[k]; },
    requireServiceRole: () => new Response("Unauthorized", { status: 401 }),
    log: () => {},
    alert: () => {},
    run: () => { ran += 1; return Promise.resolve(summary()); },
    corsHeaders: CORS,
  });
  const res = await entry(new Request("https://x/", { method: "POST" }));
  assertEquals(res.status, 401);
  assertEquals(envReads, 0, "no configuration may be read before auth passes");
  assertEquals(ran, 0);
});

Deno.test("the entry NEVER reads the request body — no client identifier can reach it", async () => {
  let ran = 0;
  const entry = makeRebookMemberOpenWorkerEntry({
    env: (k) => FULL_ENV[k],
    requireServiceRole: () => null,
    log: () => {},
    alert: () => {},
    run: () => { ran += 1; return Promise.resolve(summary()); },
    corsHeaders: CORS,
  });
  const body = JSON.stringify({
    outbox_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    academy_profile_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
    p_limit: 9999,
  });
  const req = new Request("https://x/", { method: "POST", body });
  const res = await entry(req);
  assertEquals(res.status, 200);
  assertEquals(ran, 1);
  // The definitive proof that nothing consumed it: the body stream is still unread.
  assertEquals(req.bodyUsed, false, "the entry must not consume the request body");
});

Deno.test("a disabled invocation through the full entry is 200 and never runs the worker", async () => {
  let ran = 0;
  const entry = makeRebookMemberOpenWorkerEntry({
    env: (k) => ({ ...FULL_ENV, [REBOOK_MEMBER_OPEN_SEND_FLAG]: undefined } as Record<string, string | undefined>)[k],
    requireServiceRole: () => null,
    log: () => {},
    alert: () => {},
    run: () => { ran += 1; return Promise.resolve(summary()); },
    corsHeaders: CORS,
  });
  const res = await entry(new Request("https://x/", { method: "POST" }));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { status: "disabled", reason: "disabled" });
  assertEquals(ran, 0);
});
