/**
 * The digest worker's HTTP ENTRYPOINT policy, factored out of index.ts so the real request ordering is
 * integration-testable without a server, network, or DB. index.ts is a thin wrapper that injects Deno.env,
 * requireServiceRole, a Slack alert, and a supabase-js-backed `run`.
 *
 * Endpoint status matrix (order matters — auth is FAIL-CLOSED and runs FIRST):
 *   OPTIONS                                    → 204 CORS preflight
 *   no / invalid service-role auth             → 401 (requireServiceRole, BEFORE any config read or DB)
 *   authed + switch off                        → 200 "disabled"      (zero DB)
 *   authed + switch on, config missing         → 500 "misconfigured" (zero DB, best-effort alert)
 *   authed + switch on + configured            → runs → 200 "ok" | 500 "error"
 *
 * A missing SUPABASE_SERVICE_ROLE_KEY therefore surfaces as 401 (the header can't be validated), NOT as the
 * handler's 500 "misconfigured" — the handler's config gate only fires once auth has already passed.
 */
import { runDigestWorkerHandler, type HandlerResult } from "./digest-worker-handler.ts";
import type { WorkerSummary } from "./digest-worker-core.ts";

export type EntryDeps = {
  env: (key: string) => string | undefined;
  /** Fail-closed auth: returns a 401 Response to reject, or null to allow. Runs BEFORE any config/DB access. */
  requireServiceRole: (req: Request) => Response | null;
  log: (event: Record<string, unknown>) => void;
  alert: (payload: Record<string, unknown>) => Promise<void> | void;
  run: (config: { resendApiKey: string; supabaseUrl: string; serviceKey: string }) => Promise<WorkerSummary>;
  corsHeaders: Record<string, string>;
};

export function makeDigestWorkerEntry(deps: EntryDeps): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response(null, { headers: deps.corsHeaders });

    // AUTH FIRST, fail-closed: reject before reading config or touching the DB.
    const guard = deps.requireServiceRole(req);
    if (guard) return guard;

    const result: HandlerResult = await runDigestWorkerHandler({
      env: deps.env, log: deps.log, alert: deps.alert, run: deps.run,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.http, headers: { ...deps.corsHeaders, "Content-Type": "application/json" },
    });
  };
}
