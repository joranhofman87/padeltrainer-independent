// D7 — the janitor: recovery, closure, and the properties that keep it able to un-wedge a wedged
// dispatcher (no send flag, no Resend credential, independent steps).
import { assert, assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import {
  makeRebookMemberOpenJanitorEntry,
  REBOOK_MEMBER_OPEN_JANITOR_LIMITS,
  runRebookMemberOpenJanitor,
  runRebookMemberOpenJanitorHandler,
  type JanitorSummary,
} from "./rebook-member-open-janitor-core.ts";

const OUT = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${n}`;
const REC = (n: number) => `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${n}`;

const ALLOWED_RPCS = new Set([
  "rebook_member_open_recover_expired_leases",
  "rebook_member_open_close_unresolved",
]);

function makeDeps(script: Record<string, unknown>) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const logs: Record<string, unknown>[] = [];
  const deps = {
    limits: REBOOK_MEMBER_OPEN_JANITOR_LIMITS,
    rpcTimeoutMs: 60_000,
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      const v = script[name];
      if (v instanceof Error) return Promise.reject(v);
      return Promise.resolve(v);
    },
    log: (e: Record<string, unknown>) => logs.push(e),
  };
  return { deps, calls, logs };
}

Deno.test("the two RPCs are called with the OD-5 bounds, in recovery-then-closure order", async () => {
  const { deps, calls } = makeDeps({
    rebook_member_open_recover_expired_leases: [],
    rebook_member_open_close_unresolved: [],
  });
  await runRebookMemberOpenJanitor(deps);
  assertEquals(calls.map((c) => c.name), [
    "rebook_member_open_recover_expired_leases",
    "rebook_member_open_close_unresolved",
  ]);
  assertEquals(calls[0].args, { p_limit: 500, p_stale_after_minutes: 15 });
  assertEquals(calls[1].args, { p_limit: 200 });
  // The OD-5 values are pinned on the CONSTANT the edge entrypoint injects, so making the bounds
  // injectable for evidence cannot quietly change what production runs with.
  assertEquals(REBOOK_MEMBER_OPEN_JANITOR_LIMITS, {
    recoverLimit: 500, staleAfterMinutes: 15, closeLimit: 200,
  });
  for (const c of calls) assert(ALLOWED_RPCS.has(c.name), `forbidden RPC ${c.name}`);
});

Deno.test("recovered rows are tallied by the state the DATABASE returned them to", async () => {
  const { deps } = makeDeps({
    rebook_member_open_recover_expired_leases: [
      { outbox_id: OUT(1), recovered_to: "queued", lease_generation: 4 },
      { outbox_id: OUT(2), recovered_to: "queued", lease_generation: 2 },
      { outbox_id: OUT(3), recovered_to: "acceptance_uncertain", lease_generation: 7 },
    ],
    rebook_member_open_close_unresolved: [],
  });
  const s = await runRebookMemberOpenJanitor(deps);
  assertEquals(s.status, "ok");
  assertEquals(s.recovered, 3);
  assertEquals(s.recoveredTo, { queued: 2, acceptance_uncertain: 1 });
});

Deno.test("closed rows are tallied by the terminal decision the DATABASE wrote", async () => {
  const { deps } = makeDeps({
    rebook_member_open_recover_expired_leases: [],
    rebook_member_open_close_unresolved: [
      { outbox_id: OUT(1), rebook_round_recipient_id: REC(1), decision_outcome: "dispatch_unknown" },
      { outbox_id: OUT(2), rebook_round_recipient_id: REC(2), decision_outcome: "member_window_closed" },
    ],
  });
  const s = await runRebookMemberOpenJanitor(deps);
  assertEquals(s.closed, 2);
  assertEquals(s.closedAs, { dispatch_unknown: 1, member_window_closed: 1 });
});

Deno.test("CLOSURE STILL RUNS when recovery fails — they repair independent classes", async () => {
  const { deps, calls } = makeDeps({
    rebook_member_open_recover_expired_leases: new Error("transient"),
    rebook_member_open_close_unresolved: [
      { outbox_id: OUT(1), rebook_round_recipient_id: REC(1), decision_outcome: "dispatch_unknown" },
    ],
  });
  const s: JanitorSummary = await runRebookMemberOpenJanitor(deps);
  assertEquals(s.status, "error");
  assertEquals(s.faults, ["recover_failed"]);
  assertEquals(s.closed, 1, "closure must not be skipped because recovery had an error");
  assertEquals(calls.length, 2);
});

Deno.test("an unreadable row from either step fails closed and names WHICH step", async () => {
  const bad = { rebook_member_open_recover_expired_leases: [{ outbox_id: OUT(1) }] };
  const { deps } = makeDeps({ ...bad, rebook_member_open_close_unresolved: [] });
  const s = await runRebookMemberOpenJanitor(deps);
  assertEquals(s.faults, ["recover_unreadable"]);
  assertEquals(s.status, "error");

  const { deps: d2 } = makeDeps({
    rebook_member_open_recover_expired_leases: [],
    rebook_member_open_close_unresolved: [{ outbox_id: OUT(1) }],
  });
  assertEquals((await runRebookMemberOpenJanitor(d2)).faults, ["close_unreadable"]);
});

Deno.test("a recovered_to outside the closed transport vocabulary is drift, not a new state", async () => {
  const { deps } = makeDeps({
    rebook_member_open_recover_expired_leases: [
      { outbox_id: OUT(1), recovered_to: "sent", lease_generation: 1 },
    ],
    rebook_member_open_close_unresolved: [],
  });
  assertEquals((await runRebookMemberOpenJanitor(deps)).faults, ["recover_unreadable"]);
});

// ── The handler: no flag, no provider credential ──────────────────────────────────────────────

const SUPA = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sr" };

const okSummary = (): JanitorSummary => ({
  status: "ok", recovered: 0, recoveredTo: {}, closed: 0, closedAs: {}, faults: [],
});

Deno.test("the janitor RUNS with the dispatch flag off and with NO Resend key configured", async () => {
  let ran = 0;
  const r = await runRebookMemberOpenJanitorHandler({
    // Deliberately: the send flag is absent AND RESEND_API_KEY is absent.
    env: (k) => (SUPA as Record<string, string>)[k],
    log: () => {},
    alert: () => {},
    run: () => { ran += 1; return Promise.resolve(okSummary()); },
  });
  assertEquals(r.http, 200);
  assertEquals(r.status, "ok");
  assertEquals(ran, 1, "an inert janitor would turn a stale lease into a permanent wedge");
});

Deno.test("missing Supabase config is 500 misconfigured with zero run", async () => {
  for (const missing of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    const env: Record<string, string> = { ...SUPA };
    delete env[missing];
    let ran = 0;
    const alerts: Record<string, unknown>[] = [];
    const r = await runRebookMemberOpenJanitorHandler({
      env: (k) => env[k],
      log: () => {},
      alert: (p) => { alerts.push(p); },
      run: () => { ran += 1; return Promise.resolve(okSummary()); },
    });
    assertEquals(r.http, 500);
    assertEquals(r.status, "misconfigured");
    assertEquals(ran, 0);
    assertEquals(alerts.length, 1);
  }
});

Deno.test("a thrown run leaks nothing into the response", async () => {
  const r = await runRebookMemberOpenJanitorHandler({
    env: (k) => (SUPA as Record<string, string>)[k],
    log: () => {},
    alert: () => {},
    run: () => Promise.reject(new Error("postgres://user:hunter2@db/app")),
  });
  assertEquals(r.body, { status: "error" });
  assert(!JSON.stringify(r).includes("hunter2"));
});

Deno.test("entry: OPTIONS 204, auth first, and no body read", async () => {
  let ran = 0;
  const entry = makeRebookMemberOpenJanitorEntry({
    env: (k) => (SUPA as Record<string, string>)[k],
    requireServiceRole: () => null,
    log: () => {},
    alert: () => {},
    run: () => { ran += 1; return Promise.resolve(okSummary()); },
    corsHeaders: { "Access-Control-Allow-Origin": "*" },
  });
  assertEquals((await entry(new Request("https://x/", { method: "OPTIONS" }))).status, 204);

  const req = new Request("https://x/", { method: "POST", body: '{"p_limit":100000}' });
  assertEquals((await entry(req)).status, 200);
  assertEquals(req.bodyUsed, false);
  assertEquals(ran, 1);

  let envReads = 0;
  const denied = makeRebookMemberOpenJanitorEntry({
    env: (k) => { envReads += 1; return (SUPA as Record<string, string>)[k]; },
    requireServiceRole: () => new Response("Unauthorized", { status: 401 }),
    log: () => {},
    alert: () => {},
    run: () => Promise.resolve(okSummary()),
    corsHeaders: { "Access-Control-Allow-Origin": "*" },
  });
  assertEquals((await denied(new Request("https://x/", { method: "POST" }))).status, 401);
  assertEquals(envReads, 0);
});
