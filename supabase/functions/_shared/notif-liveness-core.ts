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
  state: "live" | "inert" | "cron_missing" | "never_invoked" | "cron_disarmed" | "unexpectedly_armed" | "stale";
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
  expectArmed: boolean = false,
): Verdict {
  // The job is installed by migration; its absence means something removed it.
  if (!row.job_present) {
    return { httpStatus: 503, state: "cron_missing", detail: "the digest cron job is not present" };
  }

  const neverSucceeded = row.last_success_at === null;

  // WHY THE EXPECTATION IS AN INPUT, and not inferred from the row.
  //
  // The reviewed order is: 3c wire this monitor -> 4 canary-invoke (SUCCEEDS, cron still INACTIVE)
  // -> 5/6 reconcile and preflight -> 7 arm the cron. So between the canary and activation the row
  // reads `last_success_at != null` AND `job_active = false` — which is byte-identical to "a live
  // cron was disarmed". The six liveness fields cannot tell those apart, and no grace window can:
  // the canary window is open-ended, since steps 5 and 6 are owner-paced.
  //
  // Inferring it wrongly is not a cosmetic error. It would page continuously through the canary —
  // the exact window this monitor exists to watch — and a monitor that cries wolf during its first
  // real use is a monitor that gets muted before it is ever needed.
  //
  // So the operator states the expectation, and flips it as part of arming (step 7). Before that,
  // an inactive cron is CORRECT and is not an alert; after it, an inactive cron is the alert.
  if (!expectArmed) {
    if (row.job_active) {
      // Armed while the operator has not declared activation: the two have drifted apart.
      return { httpStatus: 503, state: "unexpectedly_armed", detail: "cron is ACTIVE but the monitor is not configured to expect activation (NOTIF_LIVENESS_EXPECT_ARMED)" };
    }
    return {
      httpStatus: 200,
      state: "inert",
      detail: neverSucceeded
        ? "cron present and inactive; worker not yet activated"
        : "cron present and inactive; a successful run exists (canary) and activation is not yet expected",
    };
  }

  // From here the operator has declared the pipeline activated.
  if (neverSucceeded) {
    // Armed without a reconciled canary behind it — off the documented path.
    return { httpStatus: 503, state: "never_invoked", detail: "activation is expected but the worker has never succeeded" };
  }

  if (!row.job_active) {
    // Activation was declared and the cron is off: disarmed, or the job was rewritten.
    return { httpStatus: 503, state: "cron_disarmed", detail: "activation is expected but the cron is INACTIVE" };
  }

  // Armed and has succeeded: the only remaining question is whether it still is.
  const age = row.seconds_since_success;
  // NEGATIVE is not "very fresh": it means a success timestamp in the future, i.e. clock skew or a
  // malformed row. Passing Number.isFinite and comparing below the threshold would report `live` on
  // corrupt data, which is the one direction a liveness check must never fail.
  if (age === null || !Number.isFinite(age) || age < 0) {
    return { httpStatus: 503, state: "stale", detail: "last success age is unavailable or not plausible" };
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
 * Fixed-width constant-time comparison over SHA-256 digests.
 *
 * The obvious `if (a.length !== b.length) return false` is NOT constant time and leaks the
 * configured token's length to anyone who can measure the response. Hashing first makes both sides
 * exactly 32 bytes whatever the inputs were, so the comparison is over a fixed width and the only
 * thing the timing can reveal is that a comparison happened.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
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
export async function isAuthorizedMonitor(req: Request, expectedToken: string | undefined): Promise<boolean> {
  if (!expectedToken) return false;
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const alt = req.headers.get("x-monitor-token") ?? "";
  if (bearer !== "" && await timingSafeEqual(bearer, expectedToken)) return true;
  if (alt !== "" && await timingSafeEqual(alt, expectedToken)) return true;
  return false;
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
