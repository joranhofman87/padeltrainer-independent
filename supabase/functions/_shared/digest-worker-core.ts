/**
 * The ADR-0008 digest WORKER loop (10c-a3), as a pure, dependency-injected core so it runs both inside the
 * edge function (Deno, wired to supabase-js + sendResendEmailOnce) AND in the real-Postgres e2e test (wired to
 * a `pg` client + a scripted fake Resend). It uses the SQL state-machine RPCs EXCLUSIVELY for every lifecycle
 * transition — it never writes digest groups / attempts / reservations / counters / members directly.
 *
 * INERT by contract: if `enabled` is false or the API key is missing it returns immediately having made ZERO
 * database calls (no worker run, no claim, no mutation). Bounded by explicit limits + a wall-clock budget.
 * Finishes worker runs truthfully; per-group failures are caught, counted, and left to the state machine's
 * crash/stale recovery (they are never re-sent inside this worker). Logs carry only IDs / states / counts /
 * redacted errors — never a destination, frozen HTML, token, or digest_item.
 */
import { renderDigestEmail, isDigestRequestOversize, type DigestItem } from "./digest-render.ts";
import type { ResendSendOnceResult } from "./resend-send-once.ts";

export type FrozenRequest = { to: string; subject: string; html: string };

export type WorkerLimits = {
  maxMaterializeGroups: number;
  maxMaterializeMembers: number;
  maxAttempts: number; // hard cap on dispatch-loop iterations per invocation
  sweepLimit: number;
  wallClockMs: number; // per-invocation runtime budget
};

export type WorkerMember = { destination: string; digestItem: unknown; locale: string | null };

export type WorkerDeps = {
  enabled: boolean; // the digest kill switch (DIGEST_SEND_ENABLED === "true")
  apiKeyPresent: boolean; // RESEND_API_KEY configured
  channel: string; // "email"
  from: string; // DEFAULT_FROM
  limits: WorkerLimits;
  /** Call a SECURITY DEFINER RPC. MUST throw on a DB error; returns the RPC's data. */
  rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Read a group's surviving pending members (destination + digest_item + locale), ordered created_at,id. */
  loadMembers: (groupId: string) => Promise<WorkerMember[]>;
  /** Read the PERSISTED frozen request + provider idempotency key the state machine owns (never a re-render). */
  loadFrozen: (groupId: string) => Promise<{ request: FrozenRequest; idempotencyKey: string } | null>;
  /** Exactly-one-shot Resend send. */
  sendOnce: (
    payload: { from: string; to: string[]; subject: string; html: string },
    opts: { idempotencyKey: string },
  ) => Promise<ResendSendOnceResult>;
  now: () => Date; // wall clock for p_now
  monotonicNowMs: () => number; // for the wall-clock budget (Date.now-free, resume-safe)
  newToken: () => string; // per-invocation ownership token (crypto.randomUUID)
  log: (event: Record<string, unknown>) => void; // PII-free structured log
};

export type WorkerSummary = {
  status: "disabled" | "ok" | "error";
  reason?: string;
  sweptStale: number;
  materialized: number;
  claimed: number;
  sent: number;
  deferred: number;
  oversizeSplit: number;
  oversizeFailed: number;
  recorded: number;
  groupErrors: number;
};

/** Reduce any thrown value to a short, PII-free label for logs (never the raw message, which may echo data). */
function safeErr(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // keep only the leading clause up to the first colon/paren (RPC error prefixes), capped — no interpolated data.
  return msg.split(/[:(]/, 1)[0].trim().slice(0, 80) || "error";
}

export async function runDigestWorker(deps: WorkerDeps): Promise<WorkerSummary> {
  const s: WorkerSummary = {
    status: "ok", sweptStale: 0, materialized: 0, claimed: 0, sent: 0, deferred: 0,
    oversizeSplit: 0, oversizeFailed: 0, recorded: 0, groupErrors: 0,
  };

  // req 1 — INERT unless enabled AND configured: return with ZERO database calls.
  if (!deps.enabled) { deps.log({ event: "digest_worker_skipped", reason: "disabled" }); return { ...s, status: "disabled", reason: "disabled" }; }
  if (!deps.apiKeyPresent) { deps.log({ event: "digest_worker_skipped", reason: "no_api_key" }); return { ...s, status: "disabled", reason: "no_api_key" }; }

  const worker = deps.newToken();
  const nowIso = () => deps.now().toISOString();
  const startMs = deps.monotonicNowMs();
  const overBudget = () => deps.monotonicNowMs() - startMs > deps.limits.wallClockMs;

  let dispRun: string | null = null;
  try {
    dispRun = await deps.rpc("start_notification_worker_run", { p_worker: worker, p_channel: deps.channel, p_phase: "dispatch" }) as string;

    // (1) STALE RECONCILIATION / SWEEP — independent of the breaker; ages out due uncertain groups first.
    s.sweptStale = await deps.rpc("reconcile_notification_digest_stale", {
      p_run_id: dispRun, p_channel: deps.channel, p_now: nowIso(), p_probe_lease_minutes: 10, p_limit: deps.limits.sweepLimit,
    }) as number;

    // (2) MATERIALIZE — its own run/phase, finished truthfully.
    const matRun = await deps.rpc("start_notification_worker_run", { p_worker: worker, p_channel: deps.channel, p_phase: "materialize" }) as string;
    try {
      s.materialized = await deps.rpc("materialize_notification_digest_groups", {
        p_run_id: matRun, p_channel: deps.channel, p_now: nowIso(),
        p_max_groups: deps.limits.maxMaterializeGroups, p_max_members_per_call: deps.limits.maxMaterializeMembers,
      }) as number;
      await deps.rpc("finish_notification_worker_run", { p_run_id: matRun, p_status: "succeeded" });
    } catch (e) {
      await deps.rpc("finish_notification_worker_run", { p_run_id: matRun, p_status: "failed" }).catch(() => {});
      throw e;
    }

    // (3) CLAIM → PREPARE → RENDER → (split|terminalize|store→begin→send→record) — bounded loop.
    for (let i = 0; i < deps.limits.maxAttempts; i++) {
      if (overBudget()) { deps.log({ event: "digest_worker_budget_reached", iteration: i }); break; }
      const g = await deps.rpc("claim_notification_digest_group", { p_run_id: dispRun, p_channel: deps.channel, p_now: nowIso(), p_worker: worker }) as string | null;
      if (!g) break;
      s.claimed++;

      try {
        const prep = await deps.rpc("prepare_notification_digest_group", { p_run_id: dispRun, p_group_id: g, p_worker: worker, p_now: nowIso() }) as string;
        if (prep === "no_work") { deps.log({ event: "group_no_work", group: g }); continue; }

        const members = await deps.loadMembers(g);
        if (members.length === 0) { deps.log({ event: "group_no_members", group: g }); continue; }
        const rendered = renderDigestEmail({ to: members[0].destination, locale: members[0].locale, items: members.map((m) => m.digestItem as DigestItem) });

        // §CH rendered oversize: split when reducible (>1 member), else terminalize the single item — never loop.
        if (isDigestRequestOversize(rendered)) {
          if (members.length > 1) {
            await deps.rpc("split_notification_digest_group", { p_run_id: dispRun, p_group_id: g, p_worker: worker, p_max_items_per_child: Math.max(1, Math.floor(members.length / 2)), p_now: nowIso() });
            s.oversizeSplit++; deps.log({ event: "group_oversize_split", group: g, members: members.length });
          } else {
            await deps.rpc("finalize_notification_digest_render_oversize", { p_run_id: dispRun, p_group_id: g, p_worker: worker, p_now: nowIso() });
            s.oversizeFailed++; deps.log({ event: "group_oversize_terminal", group: g });
          }
          continue;
        }

        // store the validated+hashed+frozen request, then begin the attempt.
        await deps.rpc("store_notification_digest_request", { p_run_id: dispRun, p_group_id: g, p_worker: worker, p_frozen_request: rendered, p_now: nowIso() });
        const att = await deps.rpc("begin_notification_digest_attempt", { p_run_id: dispRun, p_group_id: g, p_worker: worker, p_now: nowIso() }) as string | null;
        if (!att) { s.deferred++; deps.log({ event: "attempt_deferred", group: g }); continue; }

        // req 6 — send the EXACT PERSISTED frozen request + the PERSISTED idempotency key (not a second render).
        const frozen = await deps.loadFrozen(g);
        if (!frozen) { deps.log({ event: "frozen_request_missing", group: g, attempt: att }); continue; }

        // req 7 — exactly ONE HTTP call for this attempt; never retry inside the worker.
        const result = await deps.sendOnce(
          { from: deps.from, to: [frozen.request.to], subject: frozen.request.subject, html: frozen.request.html },
          { idempotencyKey: frozen.idempotencyKey },
        );

        // pass EVERY observed outcome to record — transport (timeout/network/no_response) or the HTTP result.
        if (result.kind === "transport") {
          await deps.rpc("record_notification_digest_result", { p_run_id: dispRun, p_attempt_id: att, p_transport: result.transport, p_http_status: null, p_error_name: null, p_provider_message_id: null, p_now: nowIso(), p_retry_after_seconds: null });
          deps.log({ event: "attempt_recorded", group: g, attempt: att, transport: result.transport });
        } else {
          await deps.rpc("record_notification_digest_result", { p_run_id: dispRun, p_attempt_id: att, p_transport: null, p_http_status: result.httpStatus, p_error_name: result.errorName, p_provider_message_id: result.providerMessageId, p_now: nowIso(), p_retry_after_seconds: result.retryAfterSeconds });
          deps.log({ event: "attempt_recorded", group: g, attempt: att, http_status: result.httpStatus, error_name: result.errorName ?? null });
          if (result.httpStatus >= 200 && result.httpStatus < 300 && result.providerMessageId) s.sent++;
        }
        s.recorded++;
      } catch (groupErr) {
        // A per-group failure (incl. a record() failure AFTER a send) does NOT crash the worker. The group is
        // left for the state machine's crash/stale recovery (a live-but-unrecorded attempt → reclaimed next
        // tick → uncertainty). It is NEVER re-sent here.
        s.groupErrors++;
        deps.log({ event: "group_error", group: g, error: safeErr(groupErr) });
      }
    }

    // req 8 — finish truthfully. The run completed its bounded pass; per-group errors are recovered, not fatal.
    await deps.rpc("finish_notification_worker_run", { p_run_id: dispRun, p_status: "succeeded" });
    deps.log({ event: "digest_worker_done", ...s });
    return s;
  } catch (runErr) {
    // A RUN-LEVEL failure (start / sweep / materialize / finish) → finish 'failed' (never a false 'succeeded').
    // A true process death leaves the run UNFINISHED → crash recovery, exactly as intended.
    s.status = "error";
    if (dispRun) await deps.rpc("finish_notification_worker_run", { p_run_id: dispRun, p_status: "failed" }).catch(() => {});
    deps.log({ event: "digest_worker_error", error: safeErr(runErr), ...s });
    throw runErr;
  }
}
