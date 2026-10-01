/**
 * D7 — the ROUND MATERIALIZER caller: one bounded call to `rebook_round_materialize`, as a pure,
 * dependency-injected core plus its HTTP entrypoint policy.
 *
 * Materialization is the step that freezes a due round's recipient universe and writes one durable
 * decision per recipient — including the outbox rows the dispatcher will later drain. Everything
 * that decides WHICH rounds are due, WHO is in them and WHAT each recipient is owed lives in the
 * database function; this caller supplies two bounds and returns the per-round rows verbatim.
 *
 * WHY IT IS A SEPARATE FUNCTION FROM THE DISPATCHER. A materialization failure must not be able to
 * stop dispatch, and a dispatch failure must not be able to stop materialization. They have
 * different cadences (5 minutes against 2), different bounds and different failure modes; running
 * them in one invocation would couple two independent liveness properties for no gain.
 *
 * IT IS DELIBERATELY NOT BEHIND THE SEND FLAG. It performs no provider call. With the dispatch flag
 * off, the rows it writes sit unsent in the outbox — which is exactly the state a controlled activation
 * wants to be able to inspect BEFORE anything is sent.
 *
 * IT ACCEPTS NO CLIENT-CONTROLLED IDENTIFIER (S-3): no body is read, and there is no round-id
 * parameter. A caller cannot aim materialization at one academy's round.
 *
 * NOTHING HERE IS RE-DERIVED. `outcome`, `recipients_considered`, `decisions_written`, `has_more`
 * and `lifecycle` are reported exactly as returned. In particular `has_more` is the database's own
 * continuation signal and is never inferred from a row count — a caller that guessed at completion
 * would report a truncated page as an exhausted round.
 */

import { withTimeout } from "./edge-timeout.ts";
import {
  decodeMaterializeRow,
  decodeRows,
  type MaterializedRow,
} from "./rebook-member-open-transport.ts";

/**
 * The per-invocation bounds. Both sit inside the database function's own clamps
 * (`rounds ∈ [1,20]`, `recipients ∈ [1,2000]`), so these are a caller policy under a server
 * ceiling, never a way to exceed one.
 *
 * 3 rounds x 500 recipients keeps one invocation's work close to the page the frozen suite already
 * measures inside budget, and `has_more` plus the 5-minute cadence carry the remainder.
 */
export const MATERIALIZER_MAX_ROUNDS = 3;
export const MATERIALIZER_MAX_RECIPIENTS = 500;

export interface MaterializerDeps {
  /** MUST throw on a database error and return the RPC's rows. */
  rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  log: (event: Record<string, unknown>) => void;
  rpcTimeoutMs: number;
  maxRounds: number;
  maxRecipients: number;
}

export interface MaterializerSummary {
  status: "ok" | "error";
  rounds: number;
  recipientsConsidered: number;
  decisionsWritten: number;
  /** True when ANY round reported more work. The next tick picks it up. */
  hasMore: boolean;
  /** Per-round rows, verbatim. Ids and closed labels only — no recipient data exists in them. */
  results: MaterializedRow[];
  faults: string[];
}

const asRows = (data: unknown): unknown[] => (Array.isArray(data) ? data : []);

export async function runRebookRoundMaterializer(
  deps: MaterializerDeps,
): Promise<MaterializerSummary> {
  const summary: MaterializerSummary = {
    status: "ok",
    rounds: 0,
    recipientsConsidered: 0,
    decisionsWritten: 0,
    hasMore: false,
    results: [],
    faults: [],
  };
  try {
    const rows = decodeRows(
      asRows(
        await withTimeout(
          deps.rpc("rebook_round_materialize", {
            p_max_rounds: deps.maxRounds,
            p_max_recipients: deps.maxRecipients,
          }),
          deps.rpcTimeoutMs,
          "rebook_round_materialize",
        ),
      ),
      decodeMaterializeRow,
    );
    if (rows === null) {
      summary.faults.push("materialize_unreadable");
    } else {
      summary.results = rows;
      summary.rounds = rows.length;
      for (const row of rows) {
        summary.recipientsConsidered += row.recipientsConsidered;
        summary.decisionsWritten += row.decisionsWritten;
        if (row.hasMore) summary.hasMore = true;
        // A per-round `error` outcome is the DATABASE reporting that one round could not be
        // materialized while others were. It is surfaced as a fault so the run is red, and the
        // round id is kept because it is the only thing an operator can act on.
        if (row.outcome === "error") summary.faults.push("round_error");
      }
    }
  } catch {
    summary.faults.push("materialize_failed");
  }

  if (summary.faults.length > 0) summary.status = "error";
  deps.log({
    event: "rebook_round_materializer_finished",
    status: summary.status,
    rounds: summary.rounds,
    recipients_considered: summary.recipientsConsidered,
    decisions_written: summary.decisionsWritten,
    has_more: summary.hasMore,
    faults: summary.faults,
  });
  return summary;
}

// ── HTTP ENTRYPOINT POLICY ────────────────────────────────────────────────────────────────────
//
//   OPTIONS                          -> 204
//   no / invalid service-role auth   -> 401, BEFORE any config read or DB call
//   authed, Supabase config missing  -> 500 {"status":"misconfigured"}, ZERO DB
//   authed + configured              -> run -> 200 "ok" | 500 "error"
//
// There is NO send-flag arm and NO Resend credential. See the module header.

export type MaterializerHandlerResult = {
  status: string;
  http: number;
  body: Record<string, unknown>;
};

export type MaterializerHandlerDeps = {
  env: (key: string) => string | undefined;
  log: (event: Record<string, unknown>) => void;
  alert: (payload: Record<string, unknown>) => Promise<void> | void;
  run: (config: { supabaseUrl: string; serviceKey: string }) => Promise<MaterializerSummary>;
};

function safeMaterializerSummary(s: MaterializerSummary): Record<string, unknown> {
  return {
    status: s.status,
    rounds: s.rounds,
    recipients_considered: s.recipientsConsidered,
    decisions_written: s.decisionsWritten,
    has_more: s.hasMore,
    faults: s.faults,
    // VERBATIM, as the plan requires. Every field here is an id, a closed label or a count; the
    // materialize surface returns no recipient, destination or payload data at all.
    results: s.results.map((r) => ({
      round_id: r.roundId,
      academy_profile_id: r.academyProfileId,
      outcome: r.outcome,
      recipients_considered: r.recipientsConsidered,
      decisions_written: r.decisionsWritten,
      has_more: r.hasMore,
      lifecycle: r.lifecycle,
    })),
  };
}

export async function runRebookRoundMaterializerHandler(
  deps: MaterializerHandlerDeps,
): Promise<MaterializerHandlerResult> {
  const safeAlert = async (payload: Record<string, unknown>): Promise<void> => {
    try {
      await deps.alert(payload);
    } catch { /* an alert failure must not break the primary flow */ }
  };

  const supabaseUrl = deps.env("SUPABASE_URL");
  const serviceKey = deps.env("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    const missing = [
      !supabaseUrl ? "SUPABASE_URL" : null,
      !serviceKey ? "SUPABASE_SERVICE_ROLE_KEY" : null,
    ].filter(Boolean);
    deps.log({ event: "rebook_round_materializer_misconfigured", missing });
    await safeAlert({ event: "rebook_round_materializer_misconfigured", missing });
    return {
      status: "misconfigured",
      http: 500,
      body: { status: "misconfigured", reason: "missing_config" },
    };
  }

  let summary: MaterializerSummary;
  try {
    summary = await deps.run({ supabaseUrl, serviceKey });
  } catch {
    deps.log({ event: "rebook_round_materializer_invocation_error" });
    await safeAlert({ event: "rebook_round_materializer_invocation_error" });
    return { status: "error", http: 500, body: { status: "error" } };
  }
  if (summary.status === "error") {
    await safeAlert({
      event: "rebook_round_materializer_run_failed",
      status: summary.status,
      rounds: summary.rounds,
      faults: summary.faults,
    });
  }
  return {
    status: summary.status,
    http: summary.status === "error" ? 500 : 200,
    body: safeMaterializerSummary(summary),
  };
}

export type MaterializerEntryDeps = {
  env: (key: string) => string | undefined;
  requireServiceRole: (req: Request) => Response | null;
  log: (event: Record<string, unknown>) => void;
  alert: (payload: Record<string, unknown>) => Promise<void> | void;
  run: MaterializerHandlerDeps["run"];
  corsHeaders: Record<string, string>;
};

export function makeRebookRoundMaterializerEntry(
  deps: MaterializerEntryDeps,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: deps.corsHeaders });
    }
    const guard = deps.requireServiceRole(req);
    if (guard) return guard;
    // No body is read on any path.
    const result = await runRebookRoundMaterializerHandler({
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
