// D7 — the materializer caller: bounded, verbatim, flagless, and unable to be aimed at a round.
import { assert, assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import {
  makeRebookRoundMaterializerEntry,
  MATERIALIZER_MAX_RECIPIENTS,
  MATERIALIZER_MAX_ROUNDS,
  runRebookRoundMaterializer,
  runRebookRoundMaterializerHandler,
  type MaterializerSummary,
} from "./rebook-round-materializer-core.ts";

const ROUND = (n: number) => `cccccccc-cccc-4ccc-8ccc-ccccccccccc${n}`;
const ACADEMY = "11111111-1111-4111-8111-111111111111";

const row = (over: Record<string, unknown> = {}) => ({
  round_id: ROUND(1),
  academy_profile_id: ACADEMY,
  outcome: "materialized",
  recipients_considered: 120,
  decisions_written: 118,
  has_more: false,
  lifecycle: "materializing",
  ...over,
});

function makeDeps(result: unknown) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const logs: Record<string, unknown>[] = [];
  const deps = {
    rpcTimeoutMs: 60_000,
    maxRounds: MATERIALIZER_MAX_ROUNDS,
    maxRecipients: MATERIALIZER_MAX_RECIPIENTS,
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve(result);
    },
    log: (e: Record<string, unknown>) => logs.push(e),
  };
  return { deps, calls, logs };
}

Deno.test("exactly one RPC, with bounds inside the database's own clamps", async () => {
  const { deps, calls } = makeDeps([]);
  await runRebookRoundMaterializer(deps);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].name, "rebook_round_materialize");
  assertEquals(calls[0].args, { p_max_rounds: 3, p_max_recipients: 500 });
  // The database clamps rounds to [1,20] and recipients to [1,2000]; a caller policy must sit
  // inside those, never attempt to exceed them.
  assert(MATERIALIZER_MAX_ROUNDS >= 1 && MATERIALIZER_MAX_ROUNDS <= 20);
  assert(MATERIALIZER_MAX_RECIPIENTS >= 1 && MATERIALIZER_MAX_RECIPIENTS <= 2000);
  // AND THE CALL CARRIES NO IDENTIFIER. There is no round, academy or recipient parameter at all.
  assertEquals(Object.keys(calls[0].args).sort(), ["p_max_recipients", "p_max_rounds"]);
});

Deno.test("per-round rows are reported VERBATIM and the totals are their sum", async () => {
  const { deps } = makeDeps([
    row({ round_id: ROUND(1), recipients_considered: 500, decisions_written: 500, has_more: true }),
    row({ round_id: ROUND(2), recipients_considered: 12, decisions_written: 12, lifecycle: "materialized" }),
  ]);
  const s: MaterializerSummary = await runRebookRoundMaterializer(deps);
  assertEquals(s.status, "ok");
  assertEquals(s.rounds, 2);
  assertEquals(s.recipientsConsidered, 512);
  assertEquals(s.decisionsWritten, 512);
  assertEquals(s.hasMore, true, "has_more is the DATABASE's continuation signal, never inferred");
  assertEquals(s.results[0].roundId, ROUND(1));
  assertEquals(s.results[1].lifecycle, "materialized");
});

Deno.test("has_more is FALSE only when no round reported more — never guessed from a row count", async () => {
  const { deps } = makeDeps([row({ has_more: false }), row({ round_id: ROUND(2), has_more: false })]);
  assertEquals((await runRebookRoundMaterializer(deps)).hasMore, false);
  // A full page that says it is exhausted is exhausted; the caller does not second-guess it.
  const { deps: d2 } = makeDeps([row({ recipients_considered: 500, has_more: false })]);
  assertEquals((await runRebookRoundMaterializer(d2)).hasMore, false);
});

Deno.test("a per-round `error` outcome makes the run RED while the others still report", async () => {
  const { deps } = makeDeps([
    row({ round_id: ROUND(1) }),
    row({ round_id: ROUND(2), outcome: "error", recipients_considered: 0, decisions_written: 0 }),
  ]);
  const s = await runRebookRoundMaterializer(deps);
  assertEquals(s.status, "error");
  assertEquals(s.faults, ["round_error"]);
  assertEquals(s.rounds, 2);
  assertEquals(s.results[1].outcome, "error");
});

Deno.test("an unreadable row fails the whole page closed", async () => {
  const { deps } = makeDeps([{ round_id: ROUND(1) }]);
  const s = await runRebookRoundMaterializer(deps);
  assertEquals(s.faults, ["materialize_unreadable"]);
  assertEquals(s.status, "error");
  assertEquals(s.results, []);
});

Deno.test("an RPC failure is a fault, not a silent zero", async () => {
  const { deps } = makeDeps(new Error("boom"));
  const s = await runRebookRoundMaterializer(deps);
  assertEquals(s.faults, ["materialize_failed"]);
  assertEquals(s.status, "error");
  assertEquals(s.rounds, 0);
});

// ── The handler ───────────────────────────────────────────────────────────────────────────────

const SUPA = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sr" };
const okSummary = (): MaterializerSummary => ({
  status: "ok", rounds: 0, recipientsConsidered: 0, decisionsWritten: 0,
  hasMore: false, results: [], faults: [],
});

Deno.test("the materializer RUNS with the dispatch flag off and no Resend key", async () => {
  let ran = 0;
  const r = await runRebookRoundMaterializerHandler({
    env: (k) => (SUPA as Record<string, string>)[k],
    log: () => {},
    alert: () => {},
    run: () => { ran += 1; return Promise.resolve(okSummary()); },
  });
  assertEquals(r.http, 200);
  assertEquals(ran, 1, "with dispatch off the rows it writes sit unsent in the outbox — the point");
});

Deno.test("missing Supabase config is 500 misconfigured with zero run", async () => {
  let ran = 0;
  const r = await runRebookRoundMaterializerHandler({
    env: () => undefined,
    log: () => {},
    alert: () => {},
    run: () => { ran += 1; return Promise.resolve(okSummary()); },
  });
  assertEquals(r.http, 500);
  assertEquals(r.status, "misconfigured");
  assertEquals(ran, 0);
});

Deno.test("a thrown run leaks nothing into the response", async () => {
  const r = await runRebookRoundMaterializerHandler({
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
  const entry = makeRebookRoundMaterializerEntry({
    env: (k) => (SUPA as Record<string, string>)[k],
    requireServiceRole: () => null,
    log: () => {},
    alert: () => {},
    run: () => { ran += 1; return Promise.resolve(okSummary()); },
    corsHeaders: { "Access-Control-Allow-Origin": "*" },
  });
  assertEquals((await entry(new Request("https://x/", { method: "OPTIONS" }))).status, 204);
  const req = new Request("https://x/", {
    method: "POST",
    body: JSON.stringify({ round_id: ROUND(1), academy_profile_id: ACADEMY }),
  });
  assertEquals((await entry(req)).status, 200);
  assertEquals(req.bodyUsed, false, "no client identifier may be read");
  assertEquals(ran, 1);

  let envReads = 0;
  const denied = makeRebookRoundMaterializerEntry({
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
