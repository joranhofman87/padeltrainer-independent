/**
 * D7 — the transport dispatcher's HTTP ENTRYPOINT POLICY, factored out of index.ts so the real
 * request ordering is testable without a server, a network or a database.
 *
 * ENDPOINT STATUS MATRIX. The order is the policy, and it is fail-closed:
 *
 *   OPTIONS                                          -> 204 CORS preflight
 *   no / invalid service-role auth                   -> 401, BEFORE any config read or DB call
 *   authed + REBOOK_MEMBER_OPEN_SEND_ENABLED != true -> 200 {"status":"disabled"}  ZERO DB CALLS
 *   authed + enabled, RESEND/Supabase config missing -> 500 {"status":"misconfigured"} ZERO DB
 *   authed + enabled + configured                    -> run -> 200 "ok" | 500 "error"
 *
 * `REBOOK_MEMBER_OPEN_SEND_ENABLED` IS THE OD-3 SERVER-SIDE DISPATCH FLAG. It is an edge
 * ENVIRONMENT VARIABLE and it is ABSENT BY DEFAULT: `env(k) === "true"` is the only arm that turns
 * the worker on, exactly as `DIGEST_SEND_ENABLED` does for the digest worker. It therefore adds no
 * schema object, no role, no grant, no RLS policy and no API surface — which is what the release's
 * safety clause requires of an activation control.
 *
 * THE FLAG GATES THE WHOLE WORKER, NOT THE `fetch`. Gating only the provider call would still claim
 * rows, burn lease generations and leave them leased for the janitor to recover — strictly worse
 * than a clean no-op, and it would make an "inactive" deployment mutate the outbox every two
 * minutes. Disabled means zero database calls.
 *
 * THIS ENDPOINT ACCEPTS NO CLIENT-CONTROLLED IDENTIFIER OF ANY KIND (S-3). It never reads the
 * request body. There is no outbox id, round id, academy id or recipient id it can be pointed at:
 * every id it touches comes back from `claim_batch` inside the same invocation. That is what stops
 * a service-role-bearing caller from turning the dispatcher into a targeted oracle or a targeted
 * send. The digest worker's `invocation_id` body read is deliberately NOT copied here — D7 has no
 * invocation ledger, so reading a body would be accepting an identifier for no purpose at all.
 */

import type { WorkerSummary } from "./rebook-member-open-worker-core.ts";

export const REBOOK_MEMBER_OPEN_SEND_FLAG = "REBOOK_MEMBER_OPEN_SEND_ENABLED";

export type HandlerResult = { status: string; http: number; body: Record<string, unknown> };

export type HandlerDeps = {
  env: (key: string) => string | undefined;
  log: (event: Record<string, unknown>) => void;
  /**
   * Best-effort operational alert. Fires AT MOST ONCE per invocation with ids and counts only, and
   * MUST never throw — an alert failure cannot break or mask the primary flow.
   */
  alert: (payload: Record<string, unknown>) => Promise<void> | void;
  /** Build the worker deps from validated config and run it. Injected so tests need no database. */
  run: (
    config: { resendApiKey: string; supabaseUrl: string; serviceKey: string },
  ) => Promise<WorkerSummary>;
};

/** The PII-free subset of a summary that is safe to return and to alert on. */
function safeSummary(s: WorkerSummary): Record<string, unknown> {
  return {
    status: s.status,
    worker_token: s.workerToken,
    claimed: s.claimed,
    unprocessed: s.unprocessed,
    authorized: s.authorized,
    observed: s.observed,
    recorded: s.recorded,
    deferred: s.deferred,
    held: s.held,
    terminal_retained: s.terminalRetained,
    terminal_deleted: s.terminalDeleted,
    refused: s.refused,
    row_errors: s.rowErrors,
  };
}

export async function runRebookMemberOpenWorkerHandler(
  deps: HandlerDeps,
): Promise<HandlerResult> {
  // The alert is best-effort by contract; wrapping it here means even a throwing implementation
  // cannot break or mask the response.
  const safeAlert = async (payload: Record<string, unknown>): Promise<void> => {
    try {
      await deps.alert(payload);
    } catch { /* an alert failure must not break the primary flow */ }
  };

  // ── THE FLAG, FIRST, AND STRICTLY EQUAL TO THE STRING "true" ────────────────────────────────
  // Absent, empty, "TRUE", "1" and "yes" are all OFF. A permissive parse is how an activation
  // control gets flipped by an unrelated deploy default.
  if (deps.env(REBOOK_MEMBER_OPEN_SEND_FLAG) !== "true") {
    deps.log({ event: "rebook_member_open_worker_skipped", reason: "disabled" });
    return { status: "disabled", http: 200, body: { status: "disabled", reason: "disabled" } };
  }

  const resendApiKey = deps.env("RESEND_API_KEY");
  const supabaseUrl = deps.env("SUPABASE_URL");
  const serviceKey = deps.env("SUPABASE_SERVICE_ROLE_KEY");
  if (!resendApiKey || !supabaseUrl || !serviceKey) {
    // Enabled but unconfigured is a real misconfiguration: 500 plus a best-effort alert, and
    // NOTHING below runs, so still zero database calls. A missing SUPABASE_SERVICE_ROLE_KEY is
    // caught EARLIER by the entrypoint's requireServiceRole (401) — the durable backstop for a
    // wholly unconfigured function is external uptime monitoring, exactly as ADR 0008 records.
    const missing = [
      !resendApiKey ? "RESEND_API_KEY" : null,
      !supabaseUrl ? "SUPABASE_URL" : null,
      !serviceKey ? "SUPABASE_SERVICE_ROLE_KEY" : null,
    ].filter(Boolean);
    deps.log({ event: "rebook_member_open_worker_misconfigured", missing });
    await safeAlert({ event: "rebook_member_open_worker_misconfigured", missing });
    return {
      status: "misconfigured",
      http: 500,
      body: { status: "misconfigured", reason: "missing_config" },
    };
  }

  let summary: WorkerSummary;
  try {
    summary = await deps.run({ resendApiKey, supabaseUrl, serviceKey });
  } catch {
    // The thrown value is NEVER inspected or interpolated: an RPC error, a transport error or a
    // timeout can carry a host, a key or a destination in its message.
    deps.log({ event: "rebook_member_open_worker_invocation_error" });
    await safeAlert({ event: "rebook_member_open_worker_invocation_error" });
    return { status: "error", http: 500, body: { status: "error" } };
  }

  if (summary.status === "error") {
    await safeAlert({ event: "rebook_member_open_worker_run_failed", ...safeSummary(summary) });
  }
  return {
    status: summary.status,
    http: summary.status === "error" ? 500 : 200,
    body: safeSummary(summary),
  };
}

export type EntryDeps = {
  env: (key: string) => string | undefined;
  /** Fail-closed auth: a 401 Response to reject, or null to allow. Runs BEFORE config and DB. */
  requireServiceRole: (req: Request) => Response | null;
  log: (event: Record<string, unknown>) => void;
  alert: (payload: Record<string, unknown>) => Promise<void> | void;
  run: HandlerDeps["run"];
  corsHeaders: Record<string, string>;
};

export function makeRebookMemberOpenWorkerEntry(
  deps: EntryDeps,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: deps.corsHeaders });
    }

    // AUTH FIRST, FAIL-CLOSED: reject before reading any configuration or touching the database.
    const guard = deps.requireServiceRole(req);
    if (guard) return guard;

    // NOTE THE ABSENCE. No body is read here, on any path. See the module header.
    const result = await runRebookMemberOpenWorkerHandler({
      env: deps.env,
      log: deps.log,
      alert: deps.alert,
      run: deps.run,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.http,
      headers: { ...deps.corsHeaders, "Content-Type": "application/json" },
    });
  };
}
