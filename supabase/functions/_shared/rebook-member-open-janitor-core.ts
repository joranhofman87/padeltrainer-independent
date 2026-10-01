/**
 * D7 — the transport JANITOR: lease recovery and unresolved-row closure, as a pure,
 * dependency-injected core plus its HTTP entrypoint policy.
 *
 * WHY IT IS A SEPARATE FUNCTION FROM THE DISPATCHER, on a separate schedule:
 *
 *   1. its cadence is different (every 10 minutes against the dispatcher's 2), and
 *   2. A WEDGED DISPATCHER MUST NOT BE ABLE TO BLOCK THE PATH THAT UN-WEDGES IT. Recovery is what
 *      returns a lease that a crashed, timed-out or over-budget dispatcher left behind. If it
 *      lived inside the dispatcher, the one failure mode it exists to repair would also be the one
 *      that stops it running.
 *
 * IT IS DELIBERATELY NOT BEHIND THE SEND FLAG. It performs no provider call — it makes exactly two
 * RPCs, neither of which can dispatch anything — and an inert janitor turns a stale lease into a
 * PERMANENT wedge rather than a temporary one. A deployment with sending switched off still needs
 * its leases to come back.
 *
 * IT ACCEPTS NO CLIENT-CONTROLLED IDENTIFIER (S-3): no body is read, and both bounds are the
 * owner-approved constants below. There is nothing a caller can point it at.
 *
 * THE ASYMMETRY IS THE DATABASE'S, NOT THIS FUNCTION'S. `recover_expired_leases` returns a row to
 * its exact stored origin only when the generation was never authorized, and to
 * `acceptance_uncertain` when it was. This core neither knows nor influences which branch a row
 * takes; it reports what came back.
 */

import { withTimeout } from "./edge-timeout.ts";
import {
  type ClosedRow,
  decodeCloseRow,
  decodeRecoverRow,
  decodeRows,
  type RecoveredRow,
} from "./rebook-member-open-transport.ts";

export interface JanitorLimits {
  recoverLimit: number;
  /**
   * Minutes after which a lease is considered abandoned. The DISPATCHER sizes its own wall-clock
   * budget against this exact number, so the two must never drift: a healthy invocation must not
   * be able to have its own leases recovered underneath it.
   */
  staleAfterMinutes: number;
  closeLimit: number;
}

/**
 * THE OWNER-APPROVED BOUNDS (OD-5). Injected rather than hard-coded so the real-Postgres evidence
 * can drive recovery DETERMINISTICALLY with a zero-minute floor instead of waiting a quarter of an
 * hour — a floor the migration itself sanctions in those words, and which is fail-SAFE rather than
 * fail-open: recovering a live lease only bumps the generation, which makes that worker's next
 * begin or outcome refuse on capability. The edge entrypoint passes this constant and nothing else,
 * and a Deno test pins the values, so injectability costs no safety.
 */
export const REBOOK_MEMBER_OPEN_JANITOR_LIMITS: JanitorLimits = {
  recoverLimit: 500,
  staleAfterMinutes: 15,
  closeLimit: 200,
};

export interface JanitorDeps {
  /** MUST throw on a database error and return the RPC's rows. */
  rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  log: (event: Record<string, unknown>) => void;
  rpcTimeoutMs: number;
  limits: JanitorLimits;
}

export interface JanitorSummary {
  status: "ok" | "error";
  recovered: number;
  /** Recovered rows grouped by the state the database returned them to. Counts only. */
  recoveredTo: Record<string, number>;
  closed: number;
  /** Closed rows grouped by the terminal decision the database wrote. Counts only. */
  closedAs: Record<string, number>;
  /** Which of the two steps failed, as closed labels. Empty on a healthy run. */
  faults: string[];
}

const asRows = (data: unknown): unknown[] => (Array.isArray(data) ? data : []);

const tally = (into: Record<string, number>, key: string): void => {
  into[key] = (into[key] ?? 0) + 1;
};

export async function runRebookMemberOpenJanitor(deps: JanitorDeps): Promise<JanitorSummary> {
  const summary: JanitorSummary = {
    status: "ok",
    recovered: 0,
    recoveredTo: {},
    closed: 0,
    closedAs: {},
    faults: [],
  };
  const call = (name: string, args: Record<string, unknown>): Promise<unknown> =>
    withTimeout(deps.rpc(name, args), deps.rpcTimeoutMs, name);

  // ── STEP 1 — RECOVERY ───────────────────────────────────────────────────────────────────────
  // Runs first: a row that recovery moves to `acceptance_uncertain` becomes eligible for closure,
  // so doing them in this order lets one invocation carry a row all the way to a decision rather
  // than leaving it for the next tick.
  let recovered: RecoveredRow[] | null = null;
  try {
    recovered = decodeRows(
      asRows(
        await call("rebook_member_open_recover_expired_leases", {
          p_limit: deps.limits.recoverLimit,
          p_stale_after_minutes: deps.limits.staleAfterMinutes,
        }),
      ),
      decodeRecoverRow,
    );
    if (recovered === null) {
      summary.faults.push("recover_unreadable");
    } else {
      summary.recovered = recovered.length;
      for (const row of recovered) tally(summary.recoveredTo, row.recoveredTo);
    }
  } catch {
    // The thrown value is never inspected: it can carry connection or credential text.
    summary.faults.push("recover_failed");
  }

  // ── STEP 2 — CLOSURE, WHICH RUNS EVEN IF STEP 1 FAILED ──────────────────────────────────────
  // These are independent repairs of independent classes. Skipping closure because recovery had a
  // transient error would let an already-uncertain row sit undecided for reasons that have nothing
  // to do with it.
  let closed: ClosedRow[] | null = null;
  try {
    closed = decodeRows(
      asRows(await call("rebook_member_open_close_unresolved", { p_limit: deps.limits.closeLimit })),
      decodeCloseRow,
    );
    if (closed === null) {
      summary.faults.push("close_unreadable");
    } else {
      summary.closed = closed.length;
      for (const row of closed) tally(summary.closedAs, row.decisionOutcome);
    }
  } catch {
    summary.faults.push("close_failed");
  }

  if (summary.faults.length > 0) summary.status = "error";
  deps.log({
    event: "rebook_member_open_janitor_finished",
    status: summary.status,
    recovered: summary.recovered,
    recovered_to: summary.recoveredTo,
    closed: summary.closed,
    closed_as: summary.closedAs,
    faults: summary.faults,
  });
  return summary;
}

// ── HTTP ENTRYPOINT POLICY ────────────────────────────────────────────────────────────────────
//
//   OPTIONS                            -> 204
//   no / invalid service-role auth     -> 401, BEFORE any config read or DB call
//   authed, Supabase config missing    -> 500 {"status":"misconfigured"}, ZERO DB
//   authed + configured                -> run -> 200 "ok" | 500 "error"
//
// There is NO send-flag arm. See the module header.

export type JanitorHandlerResult = { status: string; http: number; body: Record<string, unknown> };

export type JanitorHandlerDeps = {
  env: (key: string) => string | undefined;
  log: (event: Record<string, unknown>) => void;
  alert: (payload: Record<string, unknown>) => Promise<void> | void;
  run: (config: { supabaseUrl: string; serviceKey: string }) => Promise<JanitorSummary>;
};

function safeJanitorSummary(s: JanitorSummary): Record<string, unknown> {
  return {
    status: s.status,
    recovered: s.recovered,
    recovered_to: s.recoveredTo,
    closed: s.closed,
    closed_as: s.closedAs,
    faults: s.faults,
  };
}

export async function runRebookMemberOpenJanitorHandler(
  deps: JanitorHandlerDeps,
): Promise<JanitorHandlerResult> {
  const safeAlert = async (payload: Record<string, unknown>): Promise<void> => {
    try {
      await deps.alert(payload);
    } catch { /* an alert failure must not break the primary flow */ }
  };

  const supabaseUrl = deps.env("SUPABASE_URL");
  const serviceKey = deps.env("SUPABASE_SERVICE_ROLE_KEY");
  // NO RESEND KEY IS READ OR REQUIRED. The janitor cannot send, so making it depend on a provider
  // credential would take the un-wedging path down whenever the sending path was misconfigured.
  if (!supabaseUrl || !serviceKey) {
    const missing = [
      !supabaseUrl ? "SUPABASE_URL" : null,
      !serviceKey ? "SUPABASE_SERVICE_ROLE_KEY" : null,
    ].filter(Boolean);
    deps.log({ event: "rebook_member_open_janitor_misconfigured", missing });
    await safeAlert({ event: "rebook_member_open_janitor_misconfigured", missing });
    return {
      status: "misconfigured",
      http: 500,
      body: { status: "misconfigured", reason: "missing_config" },
    };
  }

  let summary: JanitorSummary;
  try {
    summary = await deps.run({ supabaseUrl, serviceKey });
  } catch {
    deps.log({ event: "rebook_member_open_janitor_invocation_error" });
    await safeAlert({ event: "rebook_member_open_janitor_invocation_error" });
    return { status: "error", http: 500, body: { status: "error" } };
  }
  if (summary.status === "error") {
    await safeAlert({
      event: "rebook_member_open_janitor_run_failed",
      ...safeJanitorSummary(summary),
    });
  }
  return {
    status: summary.status,
    http: summary.status === "error" ? 500 : 200,
    body: safeJanitorSummary(summary),
  };
}

export type JanitorEntryDeps = {
  env: (key: string) => string | undefined;
  requireServiceRole: (req: Request) => Response | null;
  log: (event: Record<string, unknown>) => void;
  alert: (payload: Record<string, unknown>) => Promise<void> | void;
  run: JanitorHandlerDeps["run"];
  corsHeaders: Record<string, string>;
};

export function makeRebookMemberOpenJanitorEntry(
  deps: JanitorEntryDeps,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: deps.corsHeaders });
    }
    const guard = deps.requireServiceRole(req);
    if (guard) return guard;
    // No body is read on any path.
    const result = await runRebookMemberOpenJanitorHandler({
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
