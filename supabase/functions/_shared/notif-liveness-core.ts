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
  //
  // THE INACTIVE CHECK COMES FIRST, and the order is the meaning. `never_invoked` says "armed but
  // never succeeded"; `cron_disarmed` says "activation expected but the cron is off". When BOTH are
  // true the cron being off is the more immediate and more actionable fact — reporting
  // `never_invoked` would send the operator looking for a failing worker when nothing is scheduled
  // to run at all.
  if (!row.job_active) {
    return { httpStatus: 503, state: "cron_disarmed", detail: "activation is expected but the cron is INACTIVE" };
  }

  if (neverSucceeded) {
    // Armed without a reconciled canary behind it — off the documented path.
    return { httpStatus: 503, state: "never_invoked", detail: "cron is ARMED but the worker has never succeeded" };
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


// ═══════════════════════════════════════════════════════════════════════════════════════════
// THE HANDLER, as a factory over injected dependencies.
//
// The state machine above was testable and tested; everything AROUND it was not — auth, env
// parsing, the RPC's result shape, error redaction, headers and status codes all lived inside a
// `Deno.serve` callback that no test could reach. That is the half where an outage reads as healthy
// or a downstream error string reaches a third party, so it is the half that most needs pinning.
//
// `index.ts` is now only the wiring: real `Deno.env.get`, a real supabase client, `Deno.serve`.
// ═══════════════════════════════════════════════════════════════════════════════════════════

export type LivenessDeps = {
  /** Environment reader — injected so tests need no real process env. */
  env: (name: string) => string | undefined;
  /** Reads the liveness RPC. Resolves to the raw payload (row, array of rows, or null). */
  readLiveness: () => Promise<unknown>;
  /** Where a downstream error message goes. It must NOT reach the response. */
  logError?: (message: string) => void;
};

export const JSON_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

/**
 * Coerce the RPC payload to EXACTLY ONE VALID row, or null.
 *
 * A blind `as LivenessRow` cast was worse than no check: a payload whose fields are the wrong types
 * — `last_success_at: "garbage"`, a numeric string, a missing boolean — sailed through into the
 * state machine, where `last_success_at !== null` is true of any garbage and a plausible-looking
 * age compares below the threshold. The endpoint answered **200 live** for a response it had not
 * understood, which is the one direction a liveness check must never fail.
 *
 * The one-row contract is enforced too. `notif_digest_worker_liveness()` RETURNS TABLE with a
 * single row; more than one means the function is not what this endpoint thinks it is, and picking
 * `[0]` would hide that.
 */
export function parseLivenessRow(payload: unknown): LivenessRow | null {
  let candidate: unknown = payload;
  if (Array.isArray(payload)) {
    if (payload.length !== 1) return null;   // zero rows, or a shape we do not understand
    candidate = payload[0];
  }
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const r = candidate as Record<string, unknown>;

  const isBool = (v: unknown) => typeof v === "boolean";
  const isNullableString = (v: unknown) => v === null || typeof v === "string";
  const isNullableNumber = (v: unknown) => v === null || typeof v === "number";
  // A TIMESTAMP FIELD MUST PARSE. Type-checking it as `string` is not enough: the state machine
  // branches on `last_success_at !== null`, so any non-empty garbage — a truncated value, an error
  // string, a column that drifted — reads as "it has succeeded" and the endpoint answers 200 live
  // for a response it did not understand. For a fail-closed monitor, unparseable is unusable.
  const isNullableTimestamp = (v: unknown) =>
    v === null || (typeof v === "string" && v !== "" && Number.isFinite(Date.parse(v)));

  if (!isBool(r.job_present) || !isBool(r.job_active)) return null;
  if (!isNullableTimestamp(r.last_success_at)) return null;
  if (!isNullableNumber(r.seconds_since_success)) return null;
  if (!isNullableTimestamp(r.last_finished_at)) return null;
  if (!isNullableString(r.last_status)) return null;

  return {
    job_present: r.job_present as boolean,
    job_active: r.job_active as boolean,
    last_success_at: r.last_success_at as string | null,
    seconds_since_success: r.seconds_since_success as number | null,
    last_finished_at: r.last_finished_at as string | null,
    last_status: r.last_status as string | null,
  };
}

/** Parse the stale threshold, falling back on anything unusable rather than trusting it. */
export function resolveStaleAfter(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_STALE_AFTER_SECONDS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALE_AFTER_SECONDS;
}

export function createLivenessHandler(deps: LivenessDeps): (req: Request) => Promise<Response> {
  const log = deps.logError ?? ((m: string) => console.error("notif-liveness:", m));
  return async (req: Request): Promise<Response> => {
    if (!await isAuthorizedMonitor(req, deps.env("NOTIF_LIVENESS_TOKEN"))) {
      // No detail: an unauthenticated caller learns nothing about whether this is configured.
      return json({ ok: false, state: "unauthorized" }, 401);
    }

    if (!deps.env("SUPABASE_URL") || !deps.env("SUPABASE_SERVICE_ROLE_KEY")) {
      // A misconfigured monitor must not read as healthy.
      return json({ ok: false, state: "misconfigured", detail: "supabase env missing" }, 503);
    }

    let payload: unknown;
    try {
      payload = await deps.readLiveness();
    } catch (e) {
      // The downstream message is LOGGED, never returned: it is arbitrary text from another system
      // and can quote a row, a column value or a connection string, and this response goes to a
      // third-party uptime provider. "The read failed" is all a monitor needs to alert on.
      log(`liveness read failed: ${e instanceof Error ? e.message : String(e)}`);
      return json({ ok: false, state: "query_failed", detail: "the liveness read failed; see function logs" }, 503);
    }

    const row = parseLivenessRow(payload);
    if (!row) {
      return json({ ok: false, state: "query_failed", detail: "liveness returned no row" }, 503);
    }

    // The operator declares activation; the row cannot be asked, because a successful canary and a
    // disarmed live cron are indistinguishable in it. Flipped as part of runbook step 7a.
    const expectArmed = (deps.env("NOTIF_LIVENESS_EXPECT_ARMED") ?? "").toLowerCase() === "true";
    const verdict = decideLiveness(row, resolveStaleAfter(deps.env("NOTIF_LIVENESS_STALE_SECONDS")), expectArmed);
    return json(livenessBody(row, verdict), verdict.httpStatus);
  };
}
