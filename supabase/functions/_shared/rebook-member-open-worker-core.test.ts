// E-2 — the D7 transport worker loop, exercised through its injected boundaries only.
//
// Every arm of the six-disposition switch, every refusal fence, the provider-call ceiling and the
// wall-clock budget. Nothing here touches a network, a database or a clock.
import { assert, assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import {
  REBOOK_MEMBER_OPEN_WORKER_LIMITS,
  runRebookMemberOpenWorker,
  type WorkerLimits,
} from "./rebook-member-open-worker-core.ts";
import type { ObservedSendResult } from "./rebook-member-open-observed-send.ts";

// ── Scripting harness ─────────────────────────────────────────────────────────────────────────

const OUTBOX = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const RECIPIENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";

const claimRow = (over: Record<string, unknown> = {}) => ({
  outbox_id: OUTBOX,
  rebook_round_recipient_id: RECIPIENT,
  lease_generation: 3,
  leased_from_state: "queued",
  canonical_request_bytes: '{"from":"x","to":["y"],"subject":"s","html":"h"}',
  provider_idempotency_key: "d7:round:member:3",
  request_hash: "\\xdeadbeef",
  ...over,
});

const resolveRow = (over: Record<string, unknown> = {}) => ({
  disposition: "proceed",
  terminal_outcome: null,
  defer_until: null,
  refusal_reason: null,
  ...over,
});

const beginRow = (over: Record<string, unknown> = {}) => ({
  outcome: "begun",
  first_dispatch_at: "2026-08-25T10:00:00.000Z",
  uncertainty_deadline_at: "2026-08-25T10:30:00.000Z",
  canonical_request_bytes: '{"from":"x","to":["y"],"subject":"s","html":"h"}',
  provider_idempotency_key: "d7:round:member:3",
  refusal_reason: null,
  ...over,
});

const recordRow = (over: Record<string, unknown> = {}) => ({
  outcome: "recorded",
  transport_state: "awaiting_reconciliation",
  decision_outcome: "dispatch_accepted",
  refusal_reason: null,
  ...over,
});

const ACCEPTED: ObservedSendResult = {
  observed: true,
  httpStatus: 202,
  providerErrorCode: null,
  providerMessageId: "msg_1",
  transportFault: "none",
  envelopeStructurallyValid: true,
};

/** The ONLY RPC names this worker is ever allowed to name. Asserted on every scenario. */
const ALLOWED_RPCS = new Set([
  "rebook_member_open_claim_batch",
  "rebook_member_open_pre_dispatch_resolve",
  "rebook_member_open_begin_dispatch",
  "rebook_member_open_record_dispatch_outcome",
]);

interface Harness {
  calls: { name: string; args: Record<string, unknown> }[];
  sends: { idempotencyKey: string; requestBytes: string }[];
  logs: Record<string, unknown>[];
}

function makeDeps(
  script: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>,
  opts: {
    send?: ObservedSendResult | ((n: number) => ObservedSendResult);
    limits?: Partial<WorkerLimits>;
    clock?: number[];
  } = {},
) {
  const h: Harness = { calls: [], sends: [], logs: [] };
  let clockIndex = 0;
  const clock = opts.clock;
  const deps = {
    limits: { ...REBOOK_MEMBER_OPEN_WORKER_LIMITS, rpcTimeoutMs: 60_000, ...opts.limits },
    rpc: (name: string, args: Record<string, unknown>) => {
      h.calls.push({ name, args });
      const entry = script[name];
      if (entry === undefined) throw new Error(`unscripted rpc ${name}`);
      const value = typeof entry === "function"
        ? (entry as (a: Record<string, unknown>) => unknown)(args)
        : entry;
      if (value instanceof Error) return Promise.reject(value);
      return Promise.resolve(value);
    },
    sendOnce: (frozen: { idempotencyKey: string; requestBytes: string }) => {
      h.sends.push(frozen);
      const s = opts.send ?? ACCEPTED;
      return Promise.resolve(typeof s === "function" ? s(h.sends.length) : s);
    },
    monotonicNowMs: () => {
      if (!clock) return 0;
      const v = clock[Math.min(clockIndex, clock.length - 1)];
      clockIndex += 1;
      return v;
    },
    newToken: () => "test-worker-token",
    log: (e: Record<string, unknown>) => h.logs.push(e),
  };
  return { deps, h };
}

/** Structural control applied to every scenario: no RPC outside the allow-list is ever named. */
const assertOnlyAllowedRpcs = (h: Harness) => {
  for (const c of h.calls) {
    assert(ALLOWED_RPCS.has(c.name), `worker named a forbidden RPC: ${c.name}`);
  }
};

// ── The happy path ────────────────────────────────────────────────────────────────────────────

Deno.test("proceed: claim -> resolve -> begin -> ONE send -> record, run is healthy", async () => {
  const { deps, h } = makeDeps({
    rebook_member_open_claim_batch: [claimRow()],
    rebook_member_open_pre_dispatch_resolve: [resolveRow()],
    rebook_member_open_begin_dispatch: [beginRow()],
    rebook_member_open_record_dispatch_outcome: [recordRow()],
  });
  const s = await runRebookMemberOpenWorker(deps);
  assertEquals(s.status, "ok");
  assertEquals(s.claimed, 1);
  assertEquals(s.authorized, 1);
  assertEquals(s.observed, 1);
  assertEquals(s.recorded, 1);
  assertEquals(s.rowErrors, 0);
  assertEquals(h.sends.length, 1);
  assertOnlyAllowedRpcs(h);
});

Deno.test("the claim presents the worker's own token and the OD-5 limit of 8", async () => {
  const { deps, h } = makeDeps({ rebook_member_open_claim_batch: [] });
  await runRebookMemberOpenWorker(deps);
  assertEquals(h.calls[0].name, "rebook_member_open_claim_batch");
  assertEquals(h.calls[0].args.p_worker, "test-worker-token");
  assertEquals(h.calls[0].args.p_limit, 8);
  assertEquals(REBOOK_MEMBER_OPEN_WORKER_LIMITS.claimLimit, 8);
  assertEquals(REBOOK_MEMBER_OPEN_WORKER_LIMITS.staleAfterMinutes, 15);
});

Deno.test("the opaque request hash is handed back BYTE-IDENTICAL, never re-encoded", async () => {
  const hash = "\\x0011223344556677";
  const { deps, h } = makeDeps({
    rebook_member_open_claim_batch: [claimRow({ request_hash: hash })],
    rebook_member_open_pre_dispatch_resolve: [resolveRow()],
    rebook_member_open_begin_dispatch: [beginRow()],
    rebook_member_open_record_dispatch_outcome: [recordRow()],
  });
  await runRebookMemberOpenWorker(deps);
  const begin = h.calls.find((c) => c.name === "rebook_member_open_begin_dispatch")!;
  const record = h.calls.find((c) => c.name === "rebook_member_open_record_dispatch_outcome")!;
  assertEquals(begin.args.p_request_hash, hash);
  assertEquals(record.args.p_request_hash, hash);
});

Deno.test("a Uint8Array request hash (the `pg` carrier shape) survives unchanged too", async () => {
  const hash = new Uint8Array([0, 17, 34, 255]);
  const { deps, h } = makeDeps({
    rebook_member_open_claim_batch: [claimRow({ request_hash: hash })],
    rebook_member_open_pre_dispatch_resolve: [resolveRow()],
    rebook_member_open_begin_dispatch: [beginRow()],
    rebook_member_open_record_dispatch_outcome: [recordRow()],
  });
  await runRebookMemberOpenWorker(deps);
  const begin = h.calls.find((c) => c.name === "rebook_member_open_begin_dispatch")!;
  assert(begin.args.p_request_hash === hash, "the exact same object must be passed through");
});

Deno.test("the raw observation is recorded VERBATIM — no classification is computed", async () => {
  const observation: ObservedSendResult = {
    observed: true,
    httpStatus: 429,
    providerErrorCode: "rate_limit_exceeded",
    providerMessageId: null,
    transportFault: "none",
    envelopeStructurallyValid: true,
  };
  const { deps, h } = makeDeps({
    rebook_member_open_claim_batch: [claimRow()],
    rebook_member_open_pre_dispatch_resolve: [resolveRow()],
    rebook_member_open_begin_dispatch: [beginRow()],
    rebook_member_open_record_dispatch_outcome: [
      recordRow({ transport_state: "retry_wait", decision_outcome: null }),
    ],
  }, { send: observation });
  const s = await runRebookMemberOpenWorker(deps);
  const record = h.calls.find((c) => c.name === "rebook_member_open_record_dispatch_outcome")!;
  assertEquals(record.args.p_http_status, 429);
  assertEquals(record.args.p_provider_error_code, "rate_limit_exceeded");
  assertEquals(record.args.p_provider_message_id, null);
  assertEquals(record.args.p_transport_fault, "none");
  assertEquals(record.args.p_structurally_valid, true);
  // A 429 is NOT turned into a retry by the worker: the run is healthy and the DATABASE chose
  // `retry_wait`, which the worker merely read back.
  assertEquals(s.status, "ok");
  assertEquals(s.recorded, 1);
});

Deno.test("the frozen request the SERVER returned is sent — not the one the claim carried", async () => {
  const { deps, h } = makeDeps({
    rebook_member_open_claim_batch: [claimRow({
      canonical_request_bytes: "STALE-CLAIM-BYTES",
      provider_idempotency_key: "stale-key",
    })],
    rebook_member_open_pre_dispatch_resolve: [resolveRow()],
    rebook_member_open_begin_dispatch: [beginRow({
      canonical_request_bytes: "AUTHORITATIVE-BEGIN-BYTES",
      provider_idempotency_key: "authoritative-key",
    })],
    rebook_member_open_record_dispatch_outcome: [recordRow()],
  });
  await runRebookMemberOpenWorker(deps);
  assertEquals(h.sends[0].requestBytes, "AUTHORITATIVE-BEGIN-BYTES");
  assertEquals(h.sends[0].idempotencyKey, "authoritative-key");
});

// ── The five zero-send dispositions ───────────────────────────────────────────────────────────

for (
  const [disposition, extra, field] of [
    ["deferred", { defer_until: "2026-08-25T22:00:00.000Z" }, "deferred"],
    ["held", { refusal_reason: "renderer_unreadable" }, "held"],
    ["terminal_retained", { terminal_outcome: "recipient_opted_out" }, "terminalRetained"],
    ["terminal_deleted", { terminal_outcome: "identity_deleted" }, "terminalDeleted"],
  ] as const
) {
  Deno.test(`${disposition}: ZERO provider calls, no begin, no record, run stays healthy`, async () => {
    const { deps, h } = makeDeps({
      rebook_member_open_claim_batch: [claimRow()],
      rebook_member_open_pre_dispatch_resolve: [resolveRow({ disposition, ...extra })],
    });
    const s = await runRebookMemberOpenWorker(deps);
    assertEquals(h.sends.length, 0);
    assertEquals(s.observed, 0);
    assertEquals(s.authorized, 0);
    assertEquals(s.status, "ok");
    assertEquals(s.rowErrors, 0);
    assertEquals((s as unknown as Record<string, number>)[field], 1);
    assert(!h.calls.some((c) => c.name === "rebook_member_open_begin_dispatch"));
    assert(!h.calls.some((c) => c.name === "rebook_member_open_record_dispatch_outcome"));
    assertOnlyAllowedRpcs(h);
  });
}

Deno.test("refused disposition: ZERO provider calls, and the run is RED", async () => {
  const { deps, h } = makeDeps({
    rebook_member_open_claim_batch: [claimRow()],
    rebook_member_open_pre_dispatch_resolve: [
      resolveRow({ disposition: "refused", refusal_reason: "capability_mismatch" }),
    ],
  });
  const s = await runRebookMemberOpenWorker(deps);
  assertEquals(h.sends.length, 0);
  assertEquals(s.refused, 1);
  assertEquals(s.rowErrors, 1);
  assertEquals(s.status, "error");
  assert(h.logs.some((l) => l.fault === "resolve_refused"));
});

// ── The refusal fences ────────────────────────────────────────────────────────────────────────

Deno.test("begin refusal: ZERO provider calls, run RED, and the reason is logged as a label", async () => {
  for (
    const reason of [
      "capability_mismatch",
      "already_authorized_this_generation",
      "frozen_request_missing",
      "frozen_request_mismatch",
      "origin_state_not_admissible",
      "repost_not_contract_authorized",
      "window_invalid",
      "after_cutoff",
    ]
  ) {
    const { deps, h } = makeDeps({
      rebook_member_open_claim_batch: [claimRow()],
      rebook_member_open_pre_dispatch_resolve: [resolveRow()],
      rebook_member_open_begin_dispatch: [beginRow({
        outcome: "refused",
        canonical_request_bytes: null,
        provider_idempotency_key: null,
        first_dispatch_at: null,
        uncertainty_deadline_at: null,
        refusal_reason: reason,
      })],
    });
    const s = await runRebookMemberOpenWorker(deps);
    assertEquals(h.sends.length, 0, `${reason} must not send`);
    assertEquals(s.status, "error");
    assertEquals(s.refused, 1);
    assertEquals(s.authorized, 0);
    assert(h.logs.some((l) => l.refusal_reason === reason));
  }
});

Deno.test("record refusal: the ONE send still happened, and the run is RED", async () => {
  const { deps, h } = makeDeps({
    rebook_member_open_claim_batch: [claimRow()],
    rebook_member_open_pre_dispatch_resolve: [resolveRow()],
    rebook_member_open_begin_dispatch: [beginRow()],
    rebook_member_open_record_dispatch_outcome: [recordRow({
      outcome: "refused",
      transport_state: null,
      decision_outcome: null,
      refusal_reason: "no_dispatch_authorization",
    })],
  });
  const s = await runRebookMemberOpenWorker(deps);
  assertEquals(h.sends.length, 1);
  assertEquals(s.observed, 1);
  assertEquals(s.recorded, 0);
  assertEquals(s.refused, 1);
  assertEquals(s.status, "error");
});

Deno.test("a ZERO-CALL send refusal records NOTHING — an interaction that never happened", async () => {
  const { deps, h } = makeDeps({
    rebook_member_open_claim_batch: [claimRow()],
    rebook_member_open_pre_dispatch_resolve: [resolveRow()],
    rebook_member_open_begin_dispatch: [beginRow()],
    rebook_member_open_record_dispatch_outcome: [recordRow()],
  }, { send: { observed: false, refusal: "idempotency_key_invalid" } });
  const s = await runRebookMemberOpenWorker(deps);
  assertEquals(s.observed, 0);
  assertEquals(s.recorded, 0);
  assertEquals(s.status, "error");
  assert(
    !h.calls.some((c) => c.name === "rebook_member_open_record_dispatch_outcome"),
    "a zero-call refusal must not record a dispatch outcome",
  );
  assert(h.logs.some((l) => l.refusal === "idempotency_key_invalid"));
});

// ── Unreadable surfaces fail closed ───────────────────────────────────────────────────────────

Deno.test("an unreadable claim row leases nothing readable and reports a RED run", async () => {
  const { deps } = makeDeps({
    rebook_member_open_claim_batch: [{ outbox_id: OUTBOX }], // missing every other column
  });
  const s = await runRebookMemberOpenWorker(deps);
  assertEquals(s.status, "error");
  assertEquals(s.claimed, 1);
  assertEquals(s.unprocessed, 1);
  assertEquals(s.observed, 0);
});

Deno.test("an unreadable resolve / begin / record row each fails its row closed", async () => {
  const cases: [string, Record<string, unknown>][] = [
    ["rebook_member_open_pre_dispatch_resolve", { disposition: "proceed" }],
    ["rebook_member_open_begin_dispatch", { outcome: "begun" }],
    ["rebook_member_open_record_dispatch_outcome", { outcome: "recorded" }],
  ];
  for (const [name, bad] of cases) {
    const script: Record<string, unknown> = {
      rebook_member_open_claim_batch: [claimRow()],
      rebook_member_open_pre_dispatch_resolve: [resolveRow()],
      rebook_member_open_begin_dispatch: [beginRow()],
      rebook_member_open_record_dispatch_outcome: [recordRow()],
    };
    script[name] = [bad];
    const { deps } = makeDeps(script);
    const s = await runRebookMemberOpenWorker(deps);
    assertEquals(s.status, "error", `${name} drift must fail closed`);
    assertEquals(s.rowErrors, 1);
  }
});

Deno.test("a resolve surface returning ZERO rows is drift, not an implicit skip", async () => {
  const { deps, h } = makeDeps({
    rebook_member_open_claim_batch: [claimRow()],
    rebook_member_open_pre_dispatch_resolve: [],
  });
  const s = await runRebookMemberOpenWorker(deps);
  assertEquals(s.status, "error");
  assertEquals(h.sends.length, 0);
});

Deno.test("a claim RPC failure is a RUN failure and propagates — nothing was leased", async () => {
  const { deps } = makeDeps({ rebook_member_open_claim_batch: new Error("boom") });
  let threw = false;
  try {
    await runRebookMemberOpenWorker(deps);
  } catch {
    threw = true;
  }
  assert(threw, "a claim failure must propagate to the handler");
});

// ── The provider-call ceiling ─────────────────────────────────────────────────────────────────

Deno.test("AT MOST ONE provider call per authorized generation, across a full batch", async () => {
  const rows = [1, 2, 3].map((n) =>
    claimRow({
      outbox_id: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${n}`,
      lease_generation: n,
      provider_idempotency_key: `key-${n}`,
    })
  );
  const { deps, h } = makeDeps({
    rebook_member_open_claim_batch: rows,
    rebook_member_open_pre_dispatch_resolve: [resolveRow()],
    rebook_member_open_begin_dispatch: (args: Record<string, unknown>) => [beginRow({
      provider_idempotency_key: `key-${args.p_lease_generation}`,
    })],
    rebook_member_open_record_dispatch_outcome: [recordRow()],
  });
  const s = await runRebookMemberOpenWorker(deps);
  assertEquals(s.authorized, 3);
  assertEquals(s.observed, 3);
  assertEquals(h.sends.length, 3);
  assertEquals(
    h.calls.filter((c) => c.name === "rebook_member_open_begin_dispatch").length,
    3,
    "one begin per row and no more",
  );
  // Every send used a DISTINCT authorized key: no key was reused across generations.
  assertEquals(new Set(h.sends.map((x) => x.idempotencyKey)).size, 3);
});

Deno.test("a row fault is contained — the remaining rows still run, and the run is RED", async () => {
  const rows = [1, 2].map((n) =>
    claimRow({ outbox_id: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${n}`, lease_generation: n })
  );
  let resolveCalls = 0;
  const { deps, h } = makeDeps({
    rebook_member_open_claim_batch: rows,
    rebook_member_open_pre_dispatch_resolve: () => {
      resolveCalls += 1;
      return resolveCalls === 1
        ? [resolveRow({ disposition: "refused", refusal_reason: "capability_mismatch" })]
        : [resolveRow()];
    },
    rebook_member_open_begin_dispatch: [beginRow()],
    rebook_member_open_record_dispatch_outcome: [recordRow()],
  });
  const s = await runRebookMemberOpenWorker(deps);
  assertEquals(s.rowErrors, 1);
  assertEquals(s.recorded, 1);
  assertEquals(s.status, "error");
  assertEquals(h.sends.length, 1);
});

// ── The wall-clock budget ─────────────────────────────────────────────────────────────────────

Deno.test("the budget stops the loop STARTING rows; it never abandons one mid-flight", async () => {
  const rows = [1, 2, 3].map((n) =>
    claimRow({ outbox_id: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${n}`, lease_generation: n })
  );
  // start=0, row0 check=0 (ok), row1 check=99_999 (over budget) -> two rows unprocessed.
  const { deps, h } = makeDeps({
    rebook_member_open_claim_batch: rows,
    rebook_member_open_pre_dispatch_resolve: [resolveRow()],
    rebook_member_open_begin_dispatch: [beginRow()],
    rebook_member_open_record_dispatch_outcome: [recordRow()],
  }, { clock: [0, 0, 99_999] });
  const s = await runRebookMemberOpenWorker(deps);
  assertEquals(s.claimed, 3);
  assertEquals(s.unprocessed, 2);
  assertEquals(s.observed, 1, "the row already started ran to completion");
  assertEquals(s.status, "ok", "an exhausted budget is a healthy partial run, not a failure");
  assert(h.logs.some((l) => l.event === "rebook_member_open_worker_budget_exhausted"));
});
