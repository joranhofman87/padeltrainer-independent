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
  run: (config: { resendApiKey: string; supabaseUrl: string; serviceKey: string; invocationId: string | null }) => Promise<WorkerSummary>;
  corsHeaders: Record<string, string>;
};

/** The deliberate invocation THIS request names (N4 round 5). The scheduled command builds the
 *  body at execution time, so an artifact's request carries the id it just opened and a tick's
 *  carries null. Read leniently — an absent, malformed or non-uuid value is simply "no identity",
 *  which is the SAFE reading: a request that names nothing owns nothing, and the claim then
 *  refuses to do pipeline work while someone else's invocation is unresolved. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function readInvocationId(req: Request): Promise<string | null> {
  try {
    const raw = await req.clone().text();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const v = (parsed as Record<string, unknown>).invocation_id;
    return typeof v === "string" && UUID.test(v) ? v : null;
  } catch { return null; }
}

export function makeDigestWorkerEntry(deps: EntryDeps): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: deps.corsHeaders });

    // AUTH FIRST, fail-closed: reject before reading config or touching the DB.
    const guard = deps.requireServiceRole(req);
    if (guard) return guard;

    // AFTER auth, BEFORE any config read or DB call: reading the body is cheap and PII-free (it
    // carries one uuid), and an unauthenticated caller must never reach even this.
    const invocationId = await readInvocationId(req);

    const result: HandlerResult = await runDigestWorkerHandler({
      env: deps.env, log: deps.log, alert: deps.alert,
      run: (config) => deps.run({ ...config, invocationId }),
    });
    return new Response(JSON.stringify(result.body), {
      status: result.http, headers: { ...deps.corsHeaders, "Content-Type": "application/json" },
    });
  };
}
