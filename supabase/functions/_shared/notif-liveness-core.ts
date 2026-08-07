// N7 step 3c — the decision half of the EXTERNAL digest-worker liveness endpoint.
//
// WHY THIS EXISTS. The runbook's step 3c says "point cron/uptime monitoring at
// `public.notif_digest_worker_liveness()`". Nothing could: that function is `SECURITY DEFINER` and
// granted to `service_role` ONLY (revoked from PUBLIC/anon/authenticated by
// 20261012100000), so no uptime provider can read it, and handing one the service-role key would be
// far worse than the problem it solves. This module is the PII-free, separately-authenticated
// surface that closes the gap.
//
// WHAT MAKES IT AN EXTERNAL MONITOR, which is the whole point. The digest worker's own Slack alert
// cannot report that the worker never ran — a process that does not run sends nothing. Neither can
// the digest cron (it IS the thing under observation), nor a dashboard nobody polls, nor
// `--monitor-confirmed`, which is an operator's assertion rather than a detector. The signal has to
// come from something that runs on a different schedule, on different infrastructure, and alerts
// through a different channel. This endpoint is the read; an independent uptime service is the
// poller; its own notification channel is the alert.
//
// THE STATUS CODE IS THE CONTRACT. Every uptime provider alerts on a non-2xx without being taught
// to parse anything, so the verdict is carried by the code and the body is diagnostics. A monitor
// that has to JSON-path into a 200 is a monitor someone eventually configures wrongly.

export type LivenessRow = {
  job_present: boolean;
  job_active: boolean;
  last_success_at: string | null;
  seconds_since_success: number | null;
  last_finished_at: string | null;
  last_status: string | null;
};

export type Verdict = {
  httpStatus: 200 | 503;
  state: "live" | "inert" | "cron_missing" | "never_invoked" | "cron_disarmed" | "stale";
  detail: string;
};

/** A digest cron running every five minutes, tolerating three missed ticks before it is called stale. */
export const DEFAULT_STALE_AFTER_SECONDS = 900;

/**
 * The complete state machine, as a pure function so every branch is testable without a database.
 *
 * The ORDER matters and encodes the runbook. Activation (step 7) only happens after a canary has
 * been invoked and reconciled, so `last_success_at` is always non-null by the time the cron is
 * armed. That is why "armed but never succeeded" needs no grace window: it cannot occur on the
 * documented path, so when it does occur something is wrong and saying so immediately is correct.
 *
 * `inert` is a deliberate 200. Before activation the cron is present-and-inactive BY DESIGN, and a
 * monitor that paged through the whole inert period would be switched off long before it was ever
 * needed — which is the failure mode that leaves a live pipeline unwatched.
 */
export function decideLiveness(
  row: LivenessRow,
  staleAfterSeconds: number = DEFAULT_STALE_AFTER_SECONDS,
): Verdict {
  // The job is installed by migration; its absence means something removed it.
  if (!row.job_present) {
    return { httpStatus: 503, state: "cron_missing", detail: "the digest cron job is not present" };
  }

  const neverSucceeded = row.last_success_at === null;

  if (neverSucceeded && !row.job_active) {
    // Pre-activation: exactly the reviewed inert state. Not an alert.
    return { httpStatus: 200, state: "inert", detail: "cron present and inactive; worker not yet activated" };
  }

  if (neverSucceeded && row.job_active) {
    // Armed without a reconciled canary behind it — off the documented path.
    return { httpStatus: 503, state: "never_invoked", detail: "cron is ARMED but the worker has never succeeded" };
  }

  if (!neverSucceeded && !row.job_active) {
    // It ran before and the cron is now off: disarmed after activation, or the job was rewritten.
    return { httpStatus: 503, state: "cron_disarmed", detail: "the worker has succeeded before but the cron is now INACTIVE" };
  }

  // Armed and has succeeded: the only remaining question is whether it still is.
  const age = row.seconds_since_success;
  if (age === null || !Number.isFinite(age)) {
    return { httpStatus: 503, state: "stale", detail: "last success age is unavailable" };
  }
  if (age > staleAfterSeconds) {
    return {
      httpStatus: 503,
      state: "stale",
      detail: `last success was ${Math.round(age)}s ago (threshold ${staleAfterSeconds}s)`,
    };
  }
  return { httpStatus: 200, state: "live", detail: `last success ${Math.round(age)}s ago` };
}

/**
 * Constant-time comparison. A length-varying early return leaks the token one character at a time
 * to anyone who can measure the response, which for an internet-facing endpoint is everyone.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The monitor's own credential — deliberately NOT the service-role key.
 *
 * An uptime provider stores whatever token you give it, in their systems, and shows it in their UI.
 * The service-role key bypasses RLS on the entire database; this one authorizes reading six
 * PII-free operational booleans and timestamps. If the provider is breached, the blast radius
 * should be "someone can see whether our digest worker ran".
 *
 * Fails CLOSED: with no token configured the endpoint authorizes nobody, so a half-finished setup
 * cannot leave an open surface.
 */
export function isAuthorizedMonitor(req: Request, expectedToken: string | undefined): boolean {
  if (!expectedToken) return false;
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const alt = req.headers.get("x-monitor-token") ?? "";
  return (bearer !== "" && timingSafeEqual(bearer, expectedToken))
    || (alt !== "" && timingSafeEqual(alt, expectedToken));
}

/** The response body. Six operational fields and a verdict — nothing that identifies a person. */
export function livenessBody(row: LivenessRow, verdict: Verdict): Record<string, unknown> {
  return {
    ok: verdict.httpStatus === 200,
    state: verdict.state,
    detail: verdict.detail,
    job_present: row.job_present,
    job_active: row.job_active,
    last_success_at: row.last_success_at,
    seconds_since_success: row.seconds_since_success,
    last_finished_at: row.last_finished_at,
    last_status: row.last_status,
  };
}
