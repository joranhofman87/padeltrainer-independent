/**
 * D7 — the `rebook_member_open_player` TRANSPORT WORKER loop, as a pure, dependency-injected core.
 *
 * It runs unchanged in two places, which is the whole reason it is a core rather than an
 * entrypoint: inside the Deno edge function wired to supabase-js + `observeSingleSend`, and inside
 * a real-embedded-Postgres vitest suite wired to a `pg` client and a scripted fake provider. The
 * loop that reaches a real provider in production is therefore literally the loop the evidence
 * exercises.
 *
 * THE LOOP, AND NOTHING ELSE:
 *
 *   claim_batch                                   -> N frozen row capabilities
 *   per row: pre_dispatch_resolve                 -> one of six dispositions
 *            `proceed` only: begin_dispatch       -> the server's frozen request, or a refusal
 *                            observeSingleSend    -> EXACTLY ONE fetch, raw observation
 *                            record_dispatch_outcome
 *
 * WHAT THIS WORKER IS FORBIDDEN TO DO, and every one of these is load-bearing:
 *
 *   • ZERO CLASSIFICATION. It reports `httpStatus` / `providerErrorCode` / `providerMessageId` /
 *     `transportFault` / `envelopeStructurallyValid` exactly as observed. `rebook_member_open_
 *     classify_provider_result` is the sole classifier and it lives in the database.
 *   • ZERO RETRY. Not around the fetch, not around an RPC, not around a row. A blind retry after
 *     acceptance uncertainty is the failure mode the whole D7 transport exists to remove. A row
 *     that could not be finished is left leased and recovered by the JANITOR, which is a separate
 *     function on a separate schedule precisely so a wedged dispatcher cannot block it.
 *   • ZERO FREE TEXT. No provider message, no exception message and no destination is logged,
 *     returned or stored. Logs carry ids, counts and closed-vocabulary labels only.
 *   • NO GENERIC NOTIFICATION PATH. `checkChannelKillOrRelease`, `record_notification_send_result`,
 *     `defer_notification_outbox_row` and every other generic disposal/alert/digest mutator are
 *     absent by construction and must stay absent. The correct D7 kill behaviour is already
 *     `pre_dispatch_resolve` returning `deferred`; calling the generic release would need a grant
 *     this worker does not hold and would move a row the D7 guard did not authorize.
 *   • NO CLIENT-CONTROLLED IDENTIFIER. The worker names no outbox id, round id or academy id of
 *     its own choosing: every id it uses came out of `claim_batch` in the same invocation.
 *
 * ONE FETCH PER AUTHORIZED GENERATION. `begin_dispatch` is the only thing that authorizes a send,
 * it authorizes at most once per lease generation (`already_authorized_this_generation`), and the
 * single `observeSingleSend` call sits immediately after it with no loop around it. Zero fetches
 * occur on `deferred`, `held`, `terminal_retained`, `terminal_deleted` and `refused`.
 */

import { withTimeout } from "./edge-timeout.ts";
import { OBSERVED_SEND_TIMEOUT_MS, type ObservedSendResult } from
  "./rebook-member-open-observed-send.ts";
import {
  type ClaimedRow,
  decodeBeginRow,
  decodeClaimRow,
  decodeRecordRow,
  decodeResolveRow,
  decodeRows,
  decodeSingleRow,
  type Disposition,
} from "./rebook-member-open-transport.ts";

export interface WorkerLimits {
  /** Rows claimed per invocation. OD-5: 8. */
  claimLimit: number;
  /** How long the row loop may keep STARTING rows. OD-5 sizing note below. */
  wallClockMs: number;
  /** Per-RPC ceiling, so one hung call cannot consume the platform wall clock silently. */
  rpcTimeoutMs: number;
  /** Minutes after which the JANITOR (not this worker) considers a lease stale. OD-5: 15. */
  staleAfterMinutes: number;
}

/**
 * THE OWNER-APPROVED LIMITS (OD-5), and the arithmetic that makes them safe.
 *
 * Absolute worst-case invocation, with every bound taken at its ceiling:
 *
 *   claim                                    rpcTimeoutMs        10 s
 *   + the last row admitted at wallClockMs-1                     25 s
 *   + that row's resolve + begin + record    3 x rpcTimeoutMs    30 s
 *   + that row's ONE provider call           OBSERVED_SEND…      20 s
 *   ------------------------------------------------------------------
 *                                                                85 s
 *
 * 85 s is comfortably inside the edge platform's per-invocation wall clock and is an order of
 * magnitude under `staleAfterMinutes = 15` (900 s) — so a healthy invocation can never have its
 * own leases recovered underneath it, which would be indistinguishable from a stolen row.
 *
 * The un-budgeted ceiling the plan quotes (8 x 20 s = 160 s of provider time) is what the claim
 * limit alone would allow; `wallClockMs` is what actually bounds the run, and it stops the loop
 * from STARTING a row rather than abandoning one mid-flight — an abandoned send is precisely the
 * acceptance uncertainty this design refuses to manufacture.
 *
 * RESIDUAL, STATED RATHER THAN HIDDEN: rows claimed but not started are left `leased` and return
 * to their exact stored origin only when the janitor's recovery runs. That is a liveness delay of
 * up to `staleAfterMinutes`, never a lost message, and `unprocessed` in the summary makes it
 * visible. There is deliberately no "release without dispatch" path here: the only RPC that can
 * move a lease back is recovery, and calling it from the dispatcher would let one worker recover
 * another worker's live leases.
 */
export const REBOOK_MEMBER_OPEN_WORKER_LIMITS: WorkerLimits = {
  claimLimit: 8,
  wallClockMs: 25_000,
  rpcTimeoutMs: 10_000,
  staleAfterMinutes: 15,
};

/** The frozen request `begin_dispatch` authorized, handed to the send boundary unchanged. */
export interface WorkerDeps {
  /**
   * Call one of the eight granted machine RPCs. MUST THROW on a database error and MUST return the
   * rows as an array. `unknown` is deliberate: the decoders in the transport contract are the only
   * thing allowed to give an RPC result a shape.
   */
  rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** The single observed provider call. Injected so the suite can script it without a network. */
  sendOnce: (
    frozen: { idempotencyKey: string; requestBytes: string },
  ) => Promise<ObservedSendResult>;
  /** A monotonic millisecond clock. `performance.now()` in production; never `Date.now()`. */
  monotonicNowMs: () => number;
  /** A fresh per-invocation worker token. Never reused across invocations. */
  newToken: () => string;
  /** PII-free structured log: ids, counts and closed-vocabulary labels only. */
  log: (event: Record<string, unknown>) => void;
  limits: WorkerLimits;
}

export interface WorkerSummary {
  status: "ok" | "error";
  /** The token this invocation leased under. An id, safe to return and log. */
  workerToken: string;
  claimed: number;
  /** Rows claimed but never started because the wall-clock budget ran out. */
  unprocessed: number;
  /** `proceed` rows whose `begin_dispatch` returned `begun`, i.e. authorized sends. */
  authorized: number;
  /** Provider calls actually performed. Never exceeds `authorized`. */
  observed: number;
  /** Outcomes successfully recorded by the database. */
  recorded: number;
  /** Zero-send dispositions, by arm. */
  deferred: number;
  held: number;
  terminalRetained: number;
  terminalDeleted: number;
  /** Rows the database refused this worker's capability on, at any of the three fences. */
  refused: number;
  /** Rows that failed for any reason. A non-zero value forces `status: "error"`. */
  rowErrors: number;
}

/** A per-row failure. Carries a closed label only — never a message, never provider text. */
class RowFault extends Error {
  readonly label: string;
  constructor(label: string) {
    super(label);
    this.name = "RowFault";
    this.label = label;
  }
}

/** Every closed row-fault label this worker can produce. Exhaustive, and asserted by the tests. */
export const ROW_FAULT_LABELS = [
  "resolve_unreadable",
  "resolve_refused",
  "begin_unreadable",
  "begin_refused",
  "record_unreadable",
  "record_refused",
  "send_refused_zero_call",
] as const;

const asRows = (data: unknown): unknown[] => (Array.isArray(data) ? data : []);

export async function runRebookMemberOpenWorker(deps: WorkerDeps): Promise<WorkerSummary> {
  const { limits } = deps;
  const workerToken = deps.newToken();
  const startedAt = deps.monotonicNowMs();
  const elapsed = () => deps.monotonicNowMs() - startedAt;

  const call = (name: string, args: Record<string, unknown>): Promise<unknown> =>
    withTimeout(deps.rpc(name, args), limits.rpcTimeoutMs, name);

  const summary: WorkerSummary = {
    status: "ok",
    workerToken,
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
  };

  // ── CLAIM ───────────────────────────────────────────────────────────────────────────────────
  // A claim failure is a RUN failure, not a row failure: nothing has been leased, so there is
  // nothing to recover and nothing partially done. It propagates.
  const claimedRaw = await call("rebook_member_open_claim_batch", {
    p_worker: workerToken,
    p_limit: limits.claimLimit,
  });
  const claimed = decodeRows(asRows(claimedRaw), decodeClaimRow);
  if (claimed === null) {
    // The rows are leased but unreadable. They are NOT abandoned: the janitor's recovery returns
    // each to its exact stored origin, because none of them was ever authorized.
    deps.log({ event: "rebook_member_open_worker_claim_unreadable", worker_token: workerToken });
    summary.status = "error";
    summary.rowErrors = asRows(claimedRaw).length;
    summary.claimed = asRows(claimedRaw).length;
    summary.unprocessed = summary.claimed;
    return summary;
  }
  summary.claimed = claimed.length;
  deps.log({
    event: "rebook_member_open_worker_claimed",
    worker_token: workerToken,
    claimed: claimed.length,
  });

  // ── THE ROW LOOP ────────────────────────────────────────────────────────────────────────────
  for (let i = 0; i < claimed.length; i += 1) {
    if (elapsed() >= limits.wallClockMs) {
      // Stop STARTING rows. Never abandon one in flight.
      summary.unprocessed = claimed.length - i;
      deps.log({
        event: "rebook_member_open_worker_budget_exhausted",
        worker_token: workerToken,
        unprocessed: summary.unprocessed,
        elapsed_ms: Math.round(elapsed()),
      });
      break;
    }
    const row = claimed[i];
    try {
      await processRow(row, workerToken, deps, call, summary);
    } catch (err) {
      // A row fault is contained: the remaining rows still get their chance, and the run is red.
      summary.rowErrors += 1;
      summary.status = "error";
      deps.log({
        event: "rebook_member_open_worker_row_error",
        worker_token: workerToken,
        outbox_id: row.outboxId,
        lease_generation: row.leaseGeneration,
        // A CLOSED LABEL OR NOTHING. An arbitrary exception (a timeout, a transport error) carries
        // a message that can name a host, a key or a destination, so it is never interpolated.
        fault: err instanceof RowFault ? err.label : "row_exception",
      });
    }
  }

  deps.log({
    event: "rebook_member_open_worker_finished",
    worker_token: workerToken,
    status: summary.status,
    claimed: summary.claimed,
    unprocessed: summary.unprocessed,
    authorized: summary.authorized,
    observed: summary.observed,
    recorded: summary.recorded,
    deferred: summary.deferred,
    held: summary.held,
    terminal_retained: summary.terminalRetained,
    terminal_deleted: summary.terminalDeleted,
    refused: summary.refused,
    row_errors: summary.rowErrors,
    elapsed_ms: Math.round(elapsed()),
  });
  return summary;
}

/**
 * One claimed row, from resolution to recorded outcome.
 *
 * THE DISPOSITION SWITCH IS EXHAUSTIVE AND HAS NO DEFAULT ARM. The decoder has already refused
 * anything outside the closed six, so a `default:` here could only ever be dead code that would
 * silently swallow a seventh disposition if one were ever added — which is exactly the case where
 * a worker must stop rather than guess.
 */
async function processRow(
  row: ClaimedRow,
  workerToken: string,
  deps: WorkerDeps,
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  summary: WorkerSummary,
): Promise<void> {
  const resolved = decodeSingleRow(
    asRows(
      await call("rebook_member_open_pre_dispatch_resolve", {
        p_outbox_id: row.outboxId,
        p_worker_token: workerToken,
        p_lease_generation: row.leaseGeneration,
      }),
    ),
    decodeResolveRow,
  );
  if (resolved === null) throw new RowFault("resolve_unreadable");

  const disposition: Disposition = resolved.disposition;
  if (disposition !== "proceed") {
    // EVERY NON-`proceed` ARM ENDS THE ROW HERE, WITH ZERO PROVIDER CALLS. The database has
    // already written whatever durable state the arm implies (a deferral instant, a configuration
    // hold, a terminal decision, and for `terminal_deleted` the row's removal). There is nothing
    // for the worker to add, and anything it did add would be a second, unauthorized opinion.
    deps.log({
      event: "rebook_member_open_worker_disposition",
      worker_token: workerToken,
      outbox_id: row.outboxId,
      lease_generation: row.leaseGeneration,
      disposition,
      terminal_outcome: resolved.terminalOutcome,
      refusal_reason: resolved.refusalReason,
    });
    switch (disposition) {
      case "deferred":
        summary.deferred += 1;
        return;
      case "held":
        // A hold is the DATABASE deciding it cannot safely proceed, not the worker failing. It is
        // durable and it needs a human, so it is counted and named — but it does not make the run
        // red, because a single held row would then mask every later failure behind a permanently
        // red dispatcher.
        summary.held += 1;
        return;
      case "terminal_retained":
        summary.terminalRetained += 1;
        return;
      case "terminal_deleted":
        summary.terminalDeleted += 1;
        return;
      case "refused":
        // The database rejected THIS WORKER'S capability. That is the worker being wrong about a
        // row it holds, so it is a row failure. The row stays leased and recovery returns it.
        summary.refused += 1;
        throw new RowFault("resolve_refused");
    }
  }

  // ── PROCEED: authorize exactly one send ─────────────────────────────────────────────────────
  const begun = decodeSingleRow(
    asRows(
      await call("rebook_member_open_begin_dispatch", {
        p_outbox_id: row.outboxId,
        p_worker_token: workerToken,
        p_lease_generation: row.leaseGeneration,
        // THE OPAQUE HASH, HANDED BACK EXACTLY AS IT ARRIVED. The server re-derives and re-compares
        // it; the worker neither parses nor re-encodes it.
        p_request_hash: row.requestHash,
        p_canonical_request_bytes: row.canonicalRequestBytes,
        p_provider_idempotency_key: row.providerIdempotencyKey,
        p_leased_from_state: row.leasedFromState,
      }),
    ),
    decodeBeginRow,
  );
  if (begun === null) throw new RowFault("begin_unreadable");
  if (begun.outcome === "refused") {
    summary.refused += 1;
    deps.log({
      event: "rebook_member_open_worker_begin_refused",
      worker_token: workerToken,
      outbox_id: row.outboxId,
      lease_generation: row.leaseGeneration,
      refusal_reason: begun.refusalReason,
    });
    throw new RowFault("begin_refused");
  }
  // The decoder has already proven both halves are present on a `begun` row.
  const requestBytes = begun.canonicalRequestBytes as string;
  const idempotencyKey = begun.providerIdempotencyKey as string;
  summary.authorized += 1;

  // ── THE ONE CALL ────────────────────────────────────────────────────────────────────────────
  // No loop, no retry, no second call site. Its own 20 s abort is inside `observeSingleSend`, so
  // it is deliberately NOT wrapped in `withTimeout`: a second, outer deadline could resolve while
  // the real request was still in flight and turn a definite outcome into a fabricated one.
  const observation = await deps.sendOnce({ idempotencyKey, requestBytes });

  if (observation.observed === false) {
    // A ZERO-CALL REFUSAL. Nothing crossed the boundary, so there is no observation to record and
    // recording one would assert a provider interaction that never happened. The row is left in
    // its authorized generation; recovery moves it to acceptance-uncertainty because a request
    // MIGHT have crossed — which is the honest reading from the database's side, since the
    // database cannot know the fetch was never attempted.
    deps.log({
      event: "rebook_member_open_worker_send_refused",
      worker_token: workerToken,
      outbox_id: row.outboxId,
      lease_generation: row.leaseGeneration,
      refusal: observation.refusal,
    });
    throw new RowFault("send_refused_zero_call");
  }
  summary.observed += 1;

  // ── RECORD THE RAW OBSERVATION ──────────────────────────────────────────────────────────────
  const recorded = decodeSingleRow(
    asRows(
      await call("rebook_member_open_record_dispatch_outcome", {
        p_outbox_id: row.outboxId,
        p_worker_token: workerToken,
        p_lease_generation: row.leaseGeneration,
        p_request_hash: row.requestHash,
        p_http_status: observation.httpStatus,
        p_provider_error_code: observation.providerErrorCode,
        p_provider_message_id: observation.providerMessageId,
        p_transport_fault: observation.transportFault,
        p_structurally_valid: observation.envelopeStructurallyValid,
      }),
    ),
    decodeRecordRow,
  );
  if (recorded === null) throw new RowFault("record_unreadable");
  if (recorded.outcome === "refused") {
    summary.refused += 1;
    deps.log({
      event: "rebook_member_open_worker_record_refused",
      worker_token: workerToken,
      outbox_id: row.outboxId,
      lease_generation: row.leaseGeneration,
      refusal_reason: recorded.refusalReason,
    });
    throw new RowFault("record_refused");
  }
  summary.recorded += 1;
  deps.log({
    event: "rebook_member_open_worker_recorded",
    worker_token: workerToken,
    outbox_id: row.outboxId,
    lease_generation: row.leaseGeneration,
    // THE SERVER'S CLASSIFICATION, READ BACK. The worker never computed either of these.
    transport_state: recorded.transportState,
    decision_outcome: recorded.decisionOutcome,
  });
}

/** Re-exported so an entrypoint can size its own timeouts against the send ceiling. */
export { OBSERVED_SEND_TIMEOUT_MS };
