/**
 * The digest worker's HTTP-handler policy, factored out of the edge entrypoint so it is unit-testable without a
 * server or network (index.ts is a thin wrapper that injects Deno.env + a supabase-js-backed `run`).
 *
 * Config status is explicit and distinct:
 *   • switch OFF (DIGEST_SEND_ENABLED != "true")            → 200 "disabled"      (a healthy no-op, ZERO DB)
 *   • switch ON but RESEND/Supabase config missing          → 500 "misconfigured" (an alertable error, ZERO DB)
 *   • switch ON + configured                                → delegate to `run`; map its summary status to HTTP
 *
 * There is NO session-scoped advisory cron lock here: the SQL state machine's atomic `claim` (FOR UPDATE SKIP
 * LOCKED) is the concurrency boundary, so multiple concurrent invocations are already safe. (The old
 * try_lock_cron_job/unlock_cron_job pair spanned two pooled PostgREST requests without session affinity — the
 * unlock could land on a different backend and wedge the lock. Removed by design.)
 */
import type { WorkerSummary } from "./digest-worker-core.ts";

export type HandlerResult = { status: string; http: number; body: Record<string, unknown> };

export type HandlerDeps = {
  env: (key: string) => string | undefined;
  log: (event: Record<string, unknown>) => void;
  /** Build the worker deps from validated config and run it. Injected so tests need no DB. */
  run: (config: { resendApiKey: string; supabaseUrl: string; serviceKey: string }) => Promise<WorkerSummary>;
};

export async function runDigestWorkerHandler(deps: HandlerDeps): Promise<HandlerResult> {
  const enabled = deps.env("DIGEST_SEND_ENABLED") === "true";
  if (!enabled) {
    deps.log({ event: "digest_worker_skipped", reason: "disabled" });
    return { status: "disabled", http: 200, body: { status: "disabled", reason: "disabled" } };
  }

  const resendApiKey = deps.env("RESEND_API_KEY");
  const supabaseUrl = deps.env("SUPABASE_URL");
  const serviceKey = deps.env("SUPABASE_SERVICE_ROLE_KEY");
  if (!resendApiKey || !supabaseUrl || !serviceKey) {
    // enabled but unconfigured: a real misconfiguration → 500/alert. Nothing below runs, so ZERO DB mutations.
    deps.log({
      event: "digest_worker_misconfigured", reason: "missing_config",
      missing: [!resendApiKey ? "RESEND_API_KEY" : null, !supabaseUrl ? "SUPABASE_URL" : null, !serviceKey ? "SUPABASE_SERVICE_ROLE_KEY" : null].filter(Boolean),
    });
    return { status: "misconfigured", http: 500, body: { status: "misconfigured", reason: "missing_config" } };
  }

  let summary: WorkerSummary;
  try {
    summary = await deps.run({ resendApiKey, supabaseUrl, serviceKey });
  } catch {
    // runDigestWorker already finished the dispatch run 'failed' and logged a redacted error before rethrowing.
    deps.log({ event: "digest_worker_invocation_error" });
    return { status: "error", http: 500, body: { status: "error" } };
  }
  return { status: summary.status, http: summary.status === "error" ? 500 : 200, body: summary as unknown as Record<string, unknown> };
}
