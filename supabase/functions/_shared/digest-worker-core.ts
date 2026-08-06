/**
 * The ADR-0008 digest WORKER loop (10c-a3), as a pure, dependency-injected core so it runs both inside the
 * edge function (Deno, wired to supabase-js + sendResendEmailOnce) AND in the real-Postgres e2e test (wired to
 * a `pg` client + a scripted fake Resend). It uses the SQL state-machine RPCs EXCLUSIVELY for every lifecycle
 * transition — it never writes digest groups / attempts / reservations / counters / member rows directly.
 *
 * STATE-AWARE dispatch. claim does NOT normalise every group to 'leased'; it hands back a group in whatever
 * state it was due in, and each RPC accepts exactly one input state (prepare←leased, store←prepared,
 * begin←request_ready). So after claim the worker reads the owned group's state and drives the RIGHT step:
 *   • leased        → prepare → render → (split | terminalize-oversize | store) → begin → send → record
 *   • prepared      → render → (…) → store → begin → send → record   (crash recovery: prepared but not stored)
 *   • request_ready → begin → send the PERSISTED frozen request (NO re-render/re-store) → record   (a RETRY:
 *                     429 / ambiguous / stale-sending recovery / half-open probe all return here; begin reuses
 *                     the immutable frozen_request + dg:v1 key, only minting a fresh attempt_id)
 * Any other claimed state is impossible for an owned group and is treated as a group error.
 *
 * INERT by contract: disabled → returns with ZERO database calls; enabled-but-unconfigured → 'misconfigured'
 * (also zero calls), distinct from disabled so the edge handler can 500/alert. TRUTHFUL runs: a run with ANY
 * per-group failure (or an impossible missing-frozen / zero-member / unexpected-state) finishes 'failed' and
 * surfaces status 'error' (→ HTTP 500) — a failed group is NEVER reported as a healthy run — yet independent
 * groups keep processing and the failed group is left to the state machine's crash/stale recovery, never
 * re-sent here. reconcile_notification_digest_run is always called; run IDs + dimensional metrics are logged.
 * Logs carry only IDs / states / counts / redacted error labels — never a destination, frozen request, token,
 * or digest_item.
 */
import { renderDigestEmail, isDigestRequestOversize, type DigestItem } from "./digest-render.ts";
import type { ResendSendOnceResult } from "./resend-send-once.ts";
import { redactDetail } from "./redact-detail.ts";

export type FrozenRequest = { from: string; to: string; subject: string; html: string };

export type WorkerLimits = {
  maxMaterializeGroups: number;
  maxMaterializeMembers: number;
  maxAttempts: number; // hard cap on dispatch-loop iterations per invocation
  sweepLimit: number;
  /** Orphan provider events examined per invocation (10c-b E). */
  orphanReconcileLimit: number;
  wallClockMs: number; // per-invocation runtime budget
};

export type WorkerMember = { destination: string; digestItem: unknown; locale: string | null };
export type ReconcileMetric = { family: string; metric: string; count: number };

export type WorkerDeps = {
  enabled: boolean; // the digest kill switch (DIGEST_SEND_ENABLED === "true")
  apiKeyPresent: boolean; // RESEND_API_KEY (+ Supabase config) present — enabled-but-absent = misconfigured
  channel: string; // "email"
  from: string; // the platform sender, FROZEN into each request at store time
  limits: WorkerLimits;
  /** Call a SECURITY DEFINER RPC. MUST throw on a DB error; returns the RPC's data. */
  rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Read the owned group's current state (a SELECT — the worker holds the lease, so this is race-free). */
  readGroupState: (groupId: string) => Promise<string | null>;
  /** Read a group's surviving pending members (destination + digest_item + locale), ordered created_at,id. */
  loadMembers: (groupId: string) => Promise<WorkerMember[]>;
  /** Read the PERSISTED frozen request + provider idempotency key the state machine owns (never a re-render). */
  loadFrozen: (groupId: string) => Promise<{ request: FrozenRequest; idempotencyKey: string } | null>;
  /** Dimensional run reconciliation — long-format (family, metric, count) rows. */
  reconcile: (runId: string) => Promise<ReconcileMetric[]>;
  /** Exactly-one-shot Resend send (tag + idempotency key applied inside). `to` is an array (Resend's shape),
   *  built from the frozen single-string `to`. */
  sendOnce: (
    payload: { from: string; to: string[]; subject: string; html: string },
    opts: { idempotencyKey: string; groupId: string },
  ) => Promise<ResendSendOnceResult>;
  now: () => Date; // wall clock for p_now
  monotonicNowMs: () => number; // for the wall-clock budget (Date.now-free, resume-safe)
  newToken: () => string; // per-invocation ownership token
  /** The deliberate invocation THIS request names, taken from the request body the scheduled
   *  command built at execution time (N4 round 5). A cron tick carries none. */
  invocationId?: string | null;
  log: (event: Record<string, unknown>) => void; // PII-free structured log
};

export type WorkerSummary = {
  status: "disabled" | "misconfigured" | "ok" | "error";
  reason?: string;
  dispatchRunId?: string;
  /** the deliberate invocation this dispatch run claimed, when the request named one (N4 M1) */
  invocationId?: string;
  /** this request named NO invocation while a deliberate one was unresolved: the run did NO
   *  pipeline work rather than execute a second, unverified pass inside someone's evidence
   *  window (N4 round 5). Not an error — the deliberate request is still on its way. */
  invocationDeferred?: boolean;
  materializeRunId?: string;
  reconcile?: ReconcileMetric[];            // dispatch-run metrics
  reconcileMaterialize?: ReconcileMetric[]; // materialize-run metrics (every started run is reconciled)
  sweptStale: number;
  materialized: number;
  claimed: number;
  sent: number;
  deferred: number;
  oversizeSplit: number;
  oversizeFailed: number;
  recorded: number;
  groupErrors: number;
  reconcileErrors: number;   // reconciliation failures — a run whose reconcile fails is NOT operationally provable
  orphansExamined: number;   // 10c-b E — orphan provider events looked at this invocation
  orphansLinked: number;     // ...and correlated to their tagged group
  orphansQuarantined: number;// ...and given up on until an operator acts
  orphanErrors: number;      // orphan link failures — thrown OR returned in-band — unhealthy, never fatal
  correlationMismatches: number; // provider accepted a message the group is NOT bound to — MANUAL HOLD
};

/** Thrown by a run-level failure, carrying a PII-free partial summary so the handler's alert keeps the run IDs
 *  + counts. The original exception is preserved as `originalError` (and this error's message == the original's;
 *  we use an own `originalError` field rather than the ES2022 `Error.cause`, which is absent from the app's
 *  tsc lib target). */
export class DigestWorkerError extends Error {
  readonly summary: Partial<WorkerSummary>;
  readonly originalError: unknown;   // own field (Error.cause is ES2022, not in the app's tsc lib target)
  constructor(cause: unknown, summary: Partial<WorkerSummary>) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "DigestWorkerError";
    this.originalError = cause;
    this.summary = summary;
  }
}

/** The subset of a summary that is always safe to alert/return (IDs + counts, never PII). */
function safeSummary(s: WorkerSummary): Partial<WorkerSummary> {
  return {
    status: s.status, dispatchRunId: s.dispatchRunId, materializeRunId: s.materializeRunId,
    invocationId: s.invocationId, invocationDeferred: s.invocationDeferred,
    sweptStale: s.sweptStale, materialized: s.materialized, claimed: s.claimed, sent: s.sent,
    deferred: s.deferred, oversizeSplit: s.oversizeSplit, oversizeFailed: s.oversizeFailed,
    recorded: s.recorded, groupErrors: s.groupErrors, reconcileErrors: s.reconcileErrors,
    orphansExamined: s.orphansExamined, orphansLinked: s.orphansLinked,
    orphansQuarantined: s.orphansQuarantined, orphanErrors: s.orphanErrors,
    correlationMismatches: s.correlationMismatches,
  };
}

/** Reduce any thrown value to a short, PII-free label for logs. redactDetail strips emails / tokens / JWTs /
 *  ids / URL queries and length-bounds — so even an error message that happens to echo a recipient address or
 *  a provider token cannot reach the logs. (A prefix-only heuristic would leak `alice@x.com failed` verbatim.) */
function safeErr(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return redactDetail(msg, 120) || "error";
}

/** `record_notification_digest_result` RETURNS text, and a scalar RPC comes back differently
 *  depending on the client: a bare string, a one-row/one-column array, or a single-key object. The
 *  lesson this suite already paid for is that assuming ONE shape makes the read `undefined` and
 *  every assertion over it look green, so all three are normalised. Returns null when the outcome
 *  cannot be read at all — which the caller treats as unproven, never as "fine". */
function recordedOutcome(v: unknown, depth = 0): string | null {
  if (depth > 3) return null;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.length ? recordedOutcome(v[0], depth + 1) : null;
  if (v && typeof v === "object") {
    const vals = Object.values(v as Record<string, unknown>);
    return vals.length === 1 ? recordedOutcome(vals[0], depth + 1) : null;
  }
  return null;
}

/** claim_worker_invocation returns ONE row (status, invocation_id); supabase-js hands it back as a
 *  one-element array. An unreadable shape is treated as a REFUSAL, never as "no invocation": the
 *  fail-open reading would run a full pass inside an evidence window. */
function claimResult(v: unknown): { status: string; invocationId: string | null } {
  const row = Array.isArray(v) ? v[0] : v;
  if (!row || typeof row !== "object") throw new Error("claim_worker_invocation returned an unreadable result");
  const r = row as Record<string, unknown>;
  const status = typeof r.status === "string" ? r.status : null;
  if (status !== "owned" && status !== "deferred" && status !== "none") {
    throw new Error("claim_worker_invocation returned an unknown status");
  }
  return { status, invocationId: typeof r.invocation_id === "string" ? r.invocation_id : null };
}

export async function runDigestWorker(deps: WorkerDeps): Promise<WorkerSummary> {
  const s: WorkerSummary = {
    status: "ok", sweptStale: 0, materialized: 0, claimed: 0, sent: 0, deferred: 0,
    oversizeSplit: 0, oversizeFailed: 0, recorded: 0, groupErrors: 0, reconcileErrors: 0,
    orphansExamined: 0, orphansLinked: 0, orphansQuarantined: 0, orphanErrors: 0,
    correlationMismatches: 0,
  };

  // req — INERT unless enabled AND configured: return with ZERO database calls. Disabled (switch off) is a
  // healthy no-op; enabled-but-unconfigured is a MISCONFIGURATION the edge handler must 500/alert on.
  if (!deps.enabled) { deps.log({ event: "digest_worker_skipped", reason: "disabled" }); return { ...s, status: "disabled", reason: "disabled" }; }
  if (!deps.apiKeyPresent) { deps.log({ event: "digest_worker_misconfigured", reason: "missing_config" }); return { ...s, status: "misconfigured", reason: "missing_config" }; }

  const worker = deps.newToken();
  const nowIso = () => deps.now().toISOString();
  const startMs = deps.monotonicNowMs();
  const overBudget = () => deps.monotonicNowMs() - startMs > deps.limits.wallClockMs;

  // Reconcile a started run, BEST-EFFORT: it never throws (so it can't mask the original failure) and never
  // recurses (a reconcile error is logged + COUNTED, not re-reconciled). Called for EVERY run that was started —
  // materialize and dispatch, on both success and failure paths. A reconcile failure is NOT a silent no-op: it
  // increments s.reconcileErrors, which fails the affected run + the invocation (reconciliation is what makes a
  // run operationally provable, so its outage must not read as a healthy 200).
  const reconcileSafe = async (runId: string): Promise<{ metrics: ReconcileMetric[]; ok: boolean }> => {
    try { return { metrics: await deps.reconcile(runId), ok: true }; }
    catch (e) { s.reconcileErrors++; deps.log({ event: "reconcile_failed", run: runId, error: safeErr(e) }); return { metrics: [], ok: false }; }
  };

  let dispRun: string | null = null;
  try {
    dispRun = await deps.rpc("start_notification_worker_run", { p_worker: worker, p_channel: deps.channel, p_phase: "dispatch" }) as string;
    s.dispatchRunId = dispRun;

    // (0) INVOCATION CLAIM — N4 AC-6, before ANY pipeline mutation, keyed by the invocation THIS
    // REQUEST NAMES. The scheduled command's body reads a TRANSACTION-LOCAL setting that only the
    // invoke artifacts publish, so an artifact's request carries the id it just opened and every
    // cron tick's carries nothing — a tick runs in pg_cron's own session, whether it was selected
    // before the invocation existed or started long after. 'owned' may do deliberate work; 'deferred' means this request owns
    // nothing while someone else's evidence window is open, so it does NO pipeline work; 'none'
    // is the ordinary steady-state tick. A named invocation this run cannot own RAISES — the
    // throw lands in the run-level catch, which finishes this run 'failed' having done nothing.
    const claim = claimResult(await deps.rpc("claim_worker_invocation", {
      p_worker_run_id: dispRun, p_invocation_id: deps.invocationId ?? null,
    }));
    if (claim.status === "owned") {
      s.invocationId = claim.invocationId ?? undefined;
      deps.log({ event: "digest_worker_invocation_claimed", dispatch_run: dispRun, invocation: s.invocationId });
    } else if (claim.status === "deferred") {
      // finish CLEANLY with no pipeline work: nothing failed, and nothing is stranded — the
      // deliberate request is still travelling and will start its own run.
      s.invocationDeferred = true;
      deps.log({ event: "digest_worker_deferred_to_invocation", dispatch_run: dispRun });
      const rd = await reconcileSafe(dispRun);
      s.reconcile = rd.metrics;
      await deps.rpc("finish_notification_worker_run", { p_run_id: dispRun, p_status: rd.ok ? "succeeded" : "failed" });
      // …and a deferral whose RECONCILE failed is not a healthy 200 either: the run is finished
      // 'failed', so reporting ok would be the false green the reconciliation contract exists to
      // prevent. Doing no work is fine; being unable to prove it is not.
      if (!rd.ok) { s.status = "error"; s.reason = "reconcile_failed"; }
      return s;
    }

    // (1) STALE RECONCILIATION / SWEEP — ages out due uncertain groups first, independent of the breaker.
    s.sweptStale = await deps.rpc("reconcile_notification_digest_stale", {
      p_run_id: dispRun, p_channel: deps.channel, p_now: nowIso(), p_probe_lease_minutes: 10, p_limit: deps.limits.sweepLimit,
    }) as number;

    // (2) MATERIALIZE — its own run/phase, reconciled + finished truthfully on BOTH paths.
    const matRun = await deps.rpc("start_notification_worker_run", { p_worker: worker, p_channel: deps.channel, p_phase: "materialize" }) as string;
    s.materializeRunId = matRun;
    try {
      s.materialized = await deps.rpc("materialize_notification_digest_groups", {
        p_run_id: matRun, p_channel: deps.channel, p_now: nowIso(),
        p_max_groups: deps.limits.maxMaterializeGroups, p_max_members_per_call: deps.limits.maxMaterializeMembers,
      }) as number;
      const mr = await reconcileSafe(matRun);
      s.reconcileMaterialize = mr.metrics;
      deps.log({ event: "materialize_reconcile", run: matRun, metrics: mr.metrics });
      // a materialize whose RECONCILE failed is finished 'failed' (it is no longer operationally provable);
      // s.reconcileErrors already carries it into the invocation status below.
      await deps.rpc("finish_notification_worker_run", { p_run_id: matRun, p_status: mr.ok ? "succeeded" : "failed" });
    } catch (e) {
      const mr = await reconcileSafe(matRun);   // reconcile even on failure — best-effort, no mask
      s.reconcileMaterialize = mr.metrics;
      deps.log({ event: "materialize_reconcile", run: matRun, metrics: mr.metrics });
      await deps.rpc("finish_notification_worker_run", { p_run_id: matRun, p_status: "failed" }).catch(() => {});
      throw e;                                                 // original error preserved
    }

    // (3) bounded claim loop — each claimed group is dispatched according to its CURRENT state.
    for (let i = 0; i < deps.limits.maxAttempts; i++) {
      if (overBudget()) { deps.log({ event: "digest_worker_budget_reached", iteration: i }); break; }
      const g = await deps.rpc("claim_notification_digest_group", { p_run_id: dispRun, p_channel: deps.channel, p_now: nowIso(), p_worker: worker }) as string | null;
      if (!g) break;
      s.claimed++;
      try {
        await dispatchGroup(deps, dispRun, worker, g, s, nowIso);
      } catch (groupErr) {
        // A per-group failure (incl. a record() failure AFTER a send, or an impossible state) does NOT crash
        // the worker and does NOT re-send — the group is left for the state machine's crash/stale recovery. But
        // it makes the RUN unhealthy: a failed group is never reported as a healthy run.
        s.groupErrors++;
        deps.log({ event: "group_error", group: g, error: safeErr(groupErr) });
      }
    }

    // (3b) ORPHAN PROVIDER EVENTS (10c-b E). A Resend callback can arrive before its group binds
    // a provider_message_id — the webhook stores it and enrols it here rather than dropping it.
    // Until E nothing drained that queue: the SQL shipped inert with its own producer missing, so
    // an early `delivered` never reached its group and the group aged out through the stale sweep
    // as if the send had gone unanswered. Bounded per invocation and BEST-EFFORT in the same sense
    // as a group error: a failure is counted and makes the run unhealthy, but never crashes the
    // worker or re-sends anything, because linking an event only replays a transition the state
    // machine already knows how to apply idempotently.
    try {
      const rows = await deps.rpc("reconcile_orphan_provider_events", {
        p_run_id: dispRun, p_channel: deps.channel, p_now: nowIso(),
        p_limit: deps.limits.orphanReconcileLimit,
      }) as Array<Record<string, unknown>> | null;
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (row) {
        s.orphansExamined = Number(row.examined ?? 0);
        s.orphansLinked = Number(row.linked ?? 0);
        s.orphansQuarantined = Number(row.quarantined ?? 0);
        // IN-BAND failures count too. The SQL deliberately CATCHES a link failure and returns it
        // as `errors` rather than aborting the whole drain, so reading only the throw path
        // reported a run that stranded evidence — and quarantined it — as a healthy 200 with no
        // alert. `errors` already includes the missing/mismatched tagged groups that cause a
        // quarantine, so counting it once is enough, and a quarantine is a one-time transition
        // (the queue excludes quarantined rows) rather than a permanent red.
        s.orphanErrors += Number(row.errors ?? 0);
        // has_more is not a failure: the next invocation continues the queue. It is logged so a
        // queue that never drains is visible rather than merely slow.
        deps.log({ event: "orphan_reconcile", run: dispRun, metrics: row });
      }
    } catch (e) {
      s.orphanErrors++;
      deps.log({ event: "orphan_reconcile_failed", run: dispRun, error: safeErr(e) });
    }

    // (4) reconcile the dispatch run (best-effort) + log run IDs and dimensional metrics (all PII-free).
    const dr = await reconcileSafe(dispRun);
    s.reconcile = dr.metrics;
    deps.log({ event: "digest_worker_reconcile", dispatch_run: dispRun, materialize_run: matRun, metrics: dr.metrics });

    // req — finish truthfully: any per-group failure OR any RECONCILIATION failure (materialize or dispatch)
    // makes the run 'failed' → status 'error' → HTTP 500 + one alert. A reconcile outage must NOT read as a
    // healthy 200 (the run is not operationally provable), even though the send work itself committed.
    // An orphan drain failure makes the run unhealthy for the same reason a reconcile failure
    // does: the queue is the only path by which an uncorrelated callback reaches its group, so a
    // silent 200 over a broken drain hides groups that will age out as undelivered.
    //
    // A QUARANTINED orphan keeps it red for as long as it sits there, deliberately. Quarantine
    // means "no retry can fix this, a human must decide", and `quarantined` is a GAUGE of what is
    // currently parked — so failing only on the invocation that first parked it would leave a
    // permanent operator-required item behind one best-effort Slack call. The SQL states the same
    // contract at its own tail: alert while errors > 0 OR quarantined > 0.
    const failed = s.groupErrors > 0 || s.reconcileErrors > 0
      || s.orphanErrors > 0 || s.orphansQuarantined > 0
      || s.correlationMismatches > 0;
    await deps.rpc("finish_notification_worker_run", { p_run_id: dispRun, p_status: failed ? "failed" : "succeeded" });
    s.status = failed ? "error" : "ok";
    deps.log({ event: "digest_worker_done", dispatch_run: dispRun, ...s });
    return s;
  } catch (runErr) {
    // A RUN-LEVEL failure (start / sweep / materialize / claim / finish) → reconcile the dispatch run
    // best-effort (matRun is already reconciled in its own catch), finish 'failed', and re-throw. We wrap the
    // ORIGINAL error in a DigestWorkerError that PRESERVES it (same message + `cause`) and carries a PII-free
    // partial summary, so the handler's proactive alert keeps the run IDs + counts even on a thrown failure.
    s.status = "error";
    if (dispRun) {
      const dr = await reconcileSafe(dispRun);
      s.reconcile = dr.metrics;
      deps.log({ event: "digest_worker_reconcile", dispatch_run: dispRun, metrics: dr.metrics });
      await deps.rpc("finish_notification_worker_run", { p_run_id: dispRun, p_status: "failed" }).catch(() => {});
    }
    deps.log({ event: "digest_worker_error", dispatch_run: dispRun, error: safeErr(runErr), ...s });
    throw new DigestWorkerError(runErr, safeSummary(s));
  }
}

/** Dispatch one claimed+owned group by its current state. Throws on a genuine per-group failure. */
async function dispatchGroup(
  deps: WorkerDeps, dispRun: string, worker: string, g: string, s: WorkerSummary, nowIso: () => string,
): Promise<void> {
  let state = await deps.readGroupState(g);
  if (!state) throw new Error(`group ${g} vanished after claim`);

  // leased → prepare (leased-only). 'no_work' is a LEGITIMATE terminal (all members stopped), not an error.
  // 'channel_killed' (N4 M2) is a PARK: the channel's kill switch landed after claim — count it
  // deferred and walk away (no render, no store, no error; the lease rides the bounded
  // stale-reclaim window, whose claim-side gate refuses the group while the kill holds).
  if (state === "leased") {
    const prep = await deps.rpc("prepare_notification_digest_group", { p_run_id: dispRun, p_group_id: g, p_worker: worker, p_now: nowIso() }) as string;
    if (prep === "no_work") { deps.log({ event: "group_no_work", group: g }); return; }
    if (prep === "channel_killed") { s.deferred++; deps.log({ event: "group_channel_killed", group: g }); return; }
    state = "prepared";
  }

  // prepared → render surviving members, then split | terminalize-oversize | store. (Also the crash-recovery
  // entry when claim reclaims a stale 'prepared' group that was prepared but never stored.)
  if (state === "prepared") {
    const members = await deps.loadMembers(g);
    if (members.length === 0) throw new Error(`prepared group ${g} has zero members`); // impossible → group error
    const rendered = renderDigestEmail({
      from: deps.from, to: members[0].destination, locale: members[0].locale,
      items: members.map((m) => m.digestItem as DigestItem),
    });
    if (isDigestRequestOversize(rendered)) {
      if (members.length > 1) {
        await deps.rpc("split_notification_digest_group", { p_run_id: dispRun, p_group_id: g, p_worker: worker, p_max_items_per_child: Math.max(1, Math.floor(members.length / 2)), p_now: nowIso() });
        s.oversizeSplit++; deps.log({ event: "group_oversize_split", group: g, members: members.length });
      } else {
        // pass the authoritative rendered request; the RPC PROVES octet_length > 90 KB server-side.
        await deps.rpc("finalize_notification_digest_render_oversize", { p_run_id: dispRun, p_group_id: g, p_worker: worker, p_frozen_request: rendered, p_now: nowIso() });
        s.oversizeFailed++; deps.log({ event: "group_oversize_terminal", group: g });
      }
      return;
    }
    await deps.rpc("store_notification_digest_request", { p_run_id: dispRun, p_group_id: g, p_worker: worker, p_frozen_request: rendered, p_now: nowIso() });
    state = "request_ready";
  }

  // request_ready → begin (request_ready-only) then send the PERSISTED frozen request. This is the sole send
  // path — reached by a fresh group (via prepared→store above) AND by a RETRY claimed directly in request_ready
  // (begin reuses the immutable frozen_request + dg:v1 key; the worker NEVER re-renders on retry).
  if (state === "request_ready") {
    const att = await deps.rpc("begin_notification_digest_attempt", { p_run_id: dispRun, p_group_id: g, p_worker: worker, p_now: nowIso() }) as string | null;
    if (!att) { s.deferred++; deps.log({ event: "attempt_deferred", group: g }); return; } // deferred/parked — not an error
    const frozen = await deps.loadFrozen(g);
    if (!frozen) throw new Error(`request_ready group ${g} has no frozen request`); // impossible → group error

    // exactly ONE HTTP call for this attempt; the persisted request (single-string `to` → Resend array) + the
    // persisted dg:v1 key + the digest_group_id tag. Never re-rendered.
    const result = await deps.sendOnce(
      { from: frozen.request.from, to: [frozen.request.to], subject: frozen.request.subject, html: frozen.request.html },
      { idempotencyKey: frozen.idempotencyKey, groupId: g },
    );
    if (result.kind === "transport") {
      await deps.rpc("record_notification_digest_result", { p_run_id: dispRun, p_attempt_id: att, p_transport: result.transport, p_http_status: null, p_error_name: null, p_provider_message_id: null, p_now: nowIso(), p_retry_after_seconds: null });
      deps.log({ event: "attempt_recorded", group: g, attempt: att, transport: result.transport });
    } else {
      // THE RETURN VALUE IS EVIDENCE, NOT DECORATION. record_notification_digest_result writes the
      // attempt row as `accepted` BEFORE it tests whether the group is already bound to a DIFFERENT
      // provider message (20261004100000:1038 vs :1091). On a mismatch it manual-holds the channel
      // — a breaker tripped with retry_at NULL, which no backoff ever clears — and reports it ONLY
      // by returning 'correlation_mismatch'. Discarding that return left the attempt reading
      // `accepted`, the group counted as sent, and the run finishing `succeeded` over a permanently
      // mis-correlated send: the scheduler would go on ticking green while email was held open.
      //
      // It belongs in the same disjunction as `orphansQuarantined` and for the same stated reason —
      // "no retry can fix this, a human must decide".
      const rec = await deps.rpc("record_notification_digest_result", { p_run_id: dispRun, p_attempt_id: att, p_transport: null, p_http_status: result.httpStatus, p_error_name: result.errorName, p_provider_message_id: result.providerMessageId, p_now: nowIso(), p_retry_after_seconds: result.retryAfterSeconds });
      const outcome = recordedOutcome(rec);
      const mismatch = outcome === "correlation_mismatch";
      if (mismatch) s.correlationMismatches++;
      // An UNREADABLE outcome is not a passing one. If the recorded class cannot be read, we cannot
      // say this send correlated, so the group is counted as errored — the same "not operationally
      // provable" rule the reconcile and orphan paths already follow — rather than silently assumed
      // clean, which is the failure mode that let a mismatch through in the first place.
      if (outcome === null) {
        s.groupErrors++;
        deps.log({ event: "attempt_outcome_unreadable", group: g, attempt: att });
      }
      deps.log({ event: "attempt_recorded", group: g, attempt: att, http_status: result.httpStatus, error_name: result.errorName ?? null, correlation_mismatch: mismatch });
      // A mismatch is NOT a send: the message the provider accepted is not the one this group is
      // correlated to, so counting it would report a delivery that cannot be reconciled to anything.
      // Nor is an UNREADABLE outcome — `sent` must mean "the state machine recorded a clean accept",
      // and an HTTP 2xx alone is exactly the evidence that turned out not to be sufficient.
      if (outcome !== null && !mismatch
          && result.httpStatus >= 200 && result.httpStatus < 300 && result.providerMessageId) s.sent++;
    }
    s.recorded++;
    return;
  }

  // an owned group can only be leased / prepared / request_ready after claim — anything else is a real bug.
  throw new Error(`group ${g} in unexpected claimed state ${state}`);
}
