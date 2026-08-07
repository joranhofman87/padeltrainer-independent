import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DEFAULT_STALE_AFTER_SECONDS,
  createLivenessHandler,
  decideLiveness,
  firstRow,
  isAuthorizedMonitor,
  livenessBody,
  resolveStaleAfter,
  timingSafeEqual,
  type LivenessDeps,
  type LivenessRow,
} from "./notif-liveness-core.ts";

const row = (over: Partial<LivenessRow> = {}): LivenessRow => ({
  job_present: true,
  job_active: false,
  last_success_at: null,
  seconds_since_success: null,
  last_finished_at: null,
  last_status: null,
  ...over,
});

// ── the four states the N7 contract REQUIRES a monitor to detect ────────────────────────────────

Deno.test("detects: the worker was never invoked (activation expected, no success behind it)", () => {
  const v = decideLiveness(row({ job_active: true, last_success_at: null }), DEFAULT_STALE_AFTER_SECONDS, true);
  assertEquals(v.state, "never_invoked");
  assertEquals(v.httpStatus, 503);
});

Deno.test("detects: last_success_at has gone stale", () => {
  const v = decideLiveness(row({
    job_active: true,
    last_success_at: "2026-08-07T00:00:00Z",
    seconds_since_success: DEFAULT_STALE_AFTER_SECONDS + 1,
  }), DEFAULT_STALE_AFTER_SECONDS, true);
  assertEquals(v.state, "stale");
  assertEquals(v.httpStatus, 503);
});

Deno.test("detects: the cron is missing", () => {
  const v = decideLiveness(row({ job_present: false }));
  assertEquals(v.state, "cron_missing");
  assertEquals(v.httpStatus, 503);
});

Deno.test("detects: the cron went INACTIVE after activation", () => {
  // Distinguished by the OPERATOR'S declared expectation, not by last_success_at — a successful
  // canary also has last_success_at set while the cron is legitimately still inactive.
  const v = decideLiveness(row({ job_active: false, last_success_at: "2026-08-07T00:00:00Z", seconds_since_success: 60 }), DEFAULT_STALE_AFTER_SECONDS, true);
  assertEquals(v.state, "cron_disarmed");
  assertEquals(v.httpStatus, 503);
});

// ── and the states it must NOT page on ──────────────────────────────────────────────────────────

Deno.test("the CURRENT pre-activation state is 200 inert, not an alert", () => {
  // Exactly what production reports today: present, inactive, never succeeded.
  const v = decideLiveness(row({ job_present: true, job_active: false, last_success_at: null }));
  assertEquals(v.state, "inert");
  assertEquals(v.httpStatus, 200);
});

Deno.test("a healthy armed worker is 200 live", () => {
  const v = decideLiveness(row({ job_active: true, last_success_at: "2026-08-07T00:00:00Z", seconds_since_success: 120 }), DEFAULT_STALE_AFTER_SECONDS, true);
  assertEquals(v.state, "live");
  assertEquals(v.httpStatus, 200);
});

Deno.test("the threshold boundary is exclusive — exactly at it is still live", () => {
  const at = decideLiveness(row({ job_active: true, last_success_at: "x", seconds_since_success: DEFAULT_STALE_AFTER_SECONDS }), DEFAULT_STALE_AFTER_SECONDS, true);
  assertEquals(at.state, "live");
  const over = decideLiveness(row({ job_active: true, last_success_at: "x", seconds_since_success: DEFAULT_STALE_AFTER_SECONDS + 0.001 }), DEFAULT_STALE_AFTER_SECONDS, true);
  assertEquals(over.state, "stale");
});

Deno.test("an unusable age fails CLOSED rather than reporting live", () => {
  for (const bad of [null, Number.NaN, Number.POSITIVE_INFINITY, -1, -0.001]) {
    const v = decideLiveness(row({ job_active: true, last_success_at: "x", seconds_since_success: bad as number | null }), DEFAULT_STALE_AFTER_SECONDS, true);
    assertEquals(v.state, "stale", `age ${String(bad)} must not read as live`);
    assertEquals(v.httpStatus, 503);
  }
});

Deno.test("a custom threshold is honoured", () => {
  const v = decideLiveness(row({ job_active: true, last_success_at: "x", seconds_since_success: 100 }), 60, true);
  assertEquals(v.state, "stale");
});

// ── THE CANARY WINDOW: the case that made the first version page during its own first use ───────

Deno.test("a SUCCESSFUL CANARY with the cron still inactive is 200 inert, NOT cron_disarmed", () => {
  // Runbook order: 3c wire monitor -> 4 canary SUCCEEDS (cron still INACTIVE) -> 5/6 -> 7 arm.
  // Between 4 and 7 the row is last_success_at != null AND job_active = false, which is identical
  // to "a live cron was disarmed". The first implementation inferred disarmed from the row and so
  // would have paged continuously through the exact window this monitor exists to watch.
  const v = decideLiveness(
    row({ job_present: true, job_active: false, last_success_at: "2026-08-07T00:00:00Z", seconds_since_success: 30 }),
    DEFAULT_STALE_AFTER_SECONDS,
    false,   // activation not yet declared — steps 5 and 6 are owner-paced and open-ended
  );
  assertEquals(v.state, "inert");
  assertEquals(v.httpStatus, 200);
});

Deno.test("staleness does NOT apply before activation is declared", () => {
  // A canary success ages while the owner works through steps 5 and 6. The worker is not scheduled,
  // so "stale" is meaningless and would be a false page.
  const v = decideLiveness(
    row({ job_active: false, last_success_at: "x", seconds_since_success: DEFAULT_STALE_AFTER_SECONDS * 100 }),
    DEFAULT_STALE_AFTER_SECONDS,
    false,
  );
  assertEquals(v.httpStatus, 200);
});

Deno.test("armed while activation is NOT declared is itself an alert (the two have drifted)", () => {
  const v = decideLiveness(row({ job_active: true, last_success_at: "x", seconds_since_success: 10 }), DEFAULT_STALE_AFTER_SECONDS, false);
  assertEquals(v.state, "unexpectedly_armed");
  assertEquals(v.httpStatus, 503);
});

// ── the full (expectArmed x active x prior-success) table, for a PRESENT job ────────────────────
// Enumerated rather than sampled: the first version of this module was wrong about one cell, and a
// state machine is exactly the kind of thing where the untested cell is the one that bites.

Deno.test("every reachable combination maps to the intended verdict", () => {
  const cases: Array<[boolean, boolean, boolean, string, number]> = [
    // expectArmed, job_active, priorSuccess, state, http
    [false, false, false, "inert", 200],
    [false, false, true,  "inert", 200],              // the canary window
    [false, true,  false, "unexpectedly_armed", 503],
    [false, true,  true,  "unexpectedly_armed", 503],
    [true,  false, false, "cron_disarmed", 503],      // inactive outranks never-succeeded
    [true,  false, true,  "cron_disarmed", 503],
    [true,  true,  false, "never_invoked", 503],
    [true,  true,  true,  "live", 200],
  ];
  for (const [expectArmed, active, prior, state, http] of cases) {
    const v = decideLiveness(
      row({ job_present: true, job_active: active, last_success_at: prior ? "2026-08-07T00:00:00Z" : null, seconds_since_success: prior ? 30 : null }),
      DEFAULT_STALE_AFTER_SECONDS,
      expectArmed,
    );
    assertEquals(v.state, state, `expectArmed=${expectArmed} active=${active} prior=${prior}`);
    assertEquals(v.httpStatus, http, `expectArmed=${expectArmed} active=${active} prior=${prior}`);
  }
});

Deno.test("a MISSING job outranks every combination", () => {
  for (const expectArmed of [false, true]) {
    for (const active of [false, true]) {
      const v = decideLiveness(row({ job_present: false, job_active: active }), DEFAULT_STALE_AFTER_SECONDS, expectArmed);
      assertEquals(v.state, "cron_missing");
    }
  }
});

// ── authorization ───────────────────────────────────────────────────────────────────────────────

Deno.test("authorizes nobody when no token is configured (fails closed)", async () => {
  const req = new Request("https://x/", { headers: { authorization: "Bearer anything" } });
  assertFalse(await isAuthorizedMonitor(req, undefined));
  assertFalse(await isAuthorizedMonitor(req, ""));
});

Deno.test("accepts the token as Bearer or x-monitor-token, and rejects a wrong one", async () => {
  const tok = "s3cret-monitor-token";
  assert(await isAuthorizedMonitor(new Request("https://x/", { headers: { authorization: `Bearer ${tok}` } }), tok));
  assert(await isAuthorizedMonitor(new Request("https://x/", { headers: { "x-monitor-token": tok } }), tok));
  assertFalse(await isAuthorizedMonitor(new Request("https://x/", { headers: { authorization: "Bearer wrong" } }), tok));
  assertFalse(await isAuthorizedMonitor(new Request("https://x/"), tok));
});

Deno.test("timingSafeEqual is value-correct over fixed-width digests (no length short-circuit)", async () => {
  assert(await timingSafeEqual("abc", "abc"));
  assertFalse(await timingSafeEqual("abc", "abd"));
  assertFalse(await timingSafeEqual("abc", "abcd"));
  assertFalse(await timingSafeEqual("", "a"));
  // different lengths must still be COMPARED, not rejected by a length branch
  assert(await timingSafeEqual("a".repeat(200), "a".repeat(200)));
});

// ── the body must stay PII-free ─────────────────────────────────────────────────────────────────

Deno.test("the response body exposes ONLY operational fields — no recipient data", () => {
  const r = row({ job_active: true, last_success_at: "2026-08-07T00:00:00Z", seconds_since_success: 5, last_status: "succeeded" });
  const body = livenessBody(r, decideLiveness(r, DEFAULT_STALE_AFTER_SECONDS, true));
  assertEquals(
    Object.keys(body).sort(),
    ["detail", "job_active", "job_present", "last_finished_at", "last_status", "last_success_at", "ok", "seconds_since_success", "state"],
  );
  // Nothing that could carry an address, name or id.
  const serialized = JSON.stringify(body).toLowerCase();
  for (const forbidden of ["@", "email", "recipient", "user_id", "profile", "phone"]) {
    assertFalse(serialized.includes(forbidden), `body must not contain ${forbidden}`);
  }
});


// ═══════════════════════════════════════════════════════════════════════════════════════════
// HANDLER-LEVEL TESTS — auth, env, RPC shape, redaction, headers, status codes.
//
// These cover the half that used to live inside `Deno.serve` and could not be reached: the state
// machine was pinned while everything wrapping it was not, and that wrapper is where an outage
// reads as healthy or a downstream error string escapes to a third party.
// ═══════════════════════════════════════════════════════════════════════════════════════════

const TOKEN = "monitor-token-under-test";
const OK_ROW: LivenessRow = {
  job_present: true, job_active: false, last_success_at: null,
  seconds_since_success: null, last_finished_at: null, last_status: null,
};

function handlerWith(over: Partial<LivenessDeps> = {}, env: Record<string, string | undefined> = {}) {
  const base: Record<string, string | undefined> = {
    NOTIF_LIVENESS_TOKEN: TOKEN,
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
    ...env,
  };
  const logged: string[] = [];
  const handler = createLivenessHandler({
    env: (n) => base[n],
    readLiveness: async () => OK_ROW,
    logError: (m) => logged.push(m),
    ...over,
  });
  return { handler, logged };
}
const authed = (extra: HeadersInit = {}) =>
  new Request("https://x/", { headers: { authorization: `Bearer ${TOKEN}`, ...extra } });

Deno.test("handler: an unauthenticated request is 401 and leaks nothing", async () => {
  const { handler } = handlerWith();
  for (const req of [new Request("https://x/"), new Request("https://x/", { headers: { authorization: "Bearer nope" } })]) {
    const res = await handler(req);
    assertEquals(res.status, 401);
    const body = await res.json();
    assertEquals(body, { ok: false, state: "unauthorized" });   // no detail at all
  }
});

Deno.test("handler: with NO token configured, even a correct-looking bearer is refused", async () => {
  const { handler } = handlerWith({}, { NOTIF_LIVENESS_TOKEN: undefined });
  assertEquals((await handler(authed())).status, 401);
});

Deno.test("handler: missing supabase config is 503 misconfigured, never healthy", async () => {
  for (const missing of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    const { handler } = handlerWith({}, { [missing]: undefined });
    const res = await handler(authed());
    assertEquals(res.status, 503);
    assertEquals((await res.json()).state, "misconfigured");
  }
});

Deno.test("handler: an RPC failure is 503 and the raw downstream message NEVER reaches the body", async () => {
  const secretish = 'duplicate key value violates unique constraint on user_email "ada@example.com"';
  const { handler, logged } = handlerWith({ readLiveness: () => Promise.reject(new Error(secretish)) });
  const res = await handler(authed());
  assertEquals(res.status, 503);
  const body = await res.json();
  assertEquals(body.state, "query_failed");
  const serialized = JSON.stringify(body);
  assertFalse(serialized.includes("ada@example.com"), "the downstream message must not be returned");
  assertFalse(serialized.includes("duplicate key"), "the downstream message must not be returned");
  // ...but it must be LOGGED, or the operator has nothing to debug with
  assert(logged.some((m) => m.includes(secretish)), "the downstream message must be logged");
});

Deno.test("handler: an empty / no-row response is 503, not a healthy 200", async () => {
  for (const empty of [null, undefined, [], "not-a-row", 42]) {
    const { handler } = handlerWith({ readLiveness: async () => empty });
    const res = await handler(authed());
    assertEquals(res.status, 503, `payload ${JSON.stringify(empty)} must not read healthy`);
    assertEquals((await res.json()).state, "query_failed");
  }
});

Deno.test("handler: accepts BOTH the object and the single-element array RPC shapes", async () => {
  for (const payload of [OK_ROW, [OK_ROW]]) {
    const { handler } = handlerWith({ readLiveness: async () => payload });
    const res = await handler(authed());
    assertEquals(res.status, 200);
    assertEquals((await res.json()).state, "inert");
  }
});

Deno.test("handler: an unusable stale threshold falls back rather than being trusted", async () => {
  const armed: LivenessRow = { ...OK_ROW, job_active: true, last_success_at: "x", seconds_since_success: 600 };
  // 600s is inside the 900s default but outside a bogus tiny one; a bogus value must not shrink it
  for (const bad of ["0", "-5", "abc", "", "NaN", "Infinity"]) {
    const { handler } = handlerWith({ readLiveness: async () => armed },
      { NOTIF_LIVENESS_STALE_SECONDS: bad, NOTIF_LIVENESS_EXPECT_ARMED: "true" });
    assertEquals((await handler(authed())).status, 200, `threshold ${bad} should fall back to the default`);
  }
  // ...and a legitimate override IS honoured
  const { handler } = handlerWith({ readLiveness: async () => armed },
    { NOTIF_LIVENESS_STALE_SECONDS: "60", NOTIF_LIVENESS_EXPECT_ARMED: "true" });
  assertEquals((await handler(authed())).status, 503);
});

Deno.test("handler: NOTIF_LIVENESS_EXPECT_ARMED is honoured, case-insensitively, and defaults off", async () => {
  const canaryDone: LivenessRow = { ...OK_ROW, job_active: false, last_success_at: "x", seconds_since_success: 30 };
  for (const [val, status] of [[undefined, 200], ["", 200], ["false", 200], ["true", 503], ["TRUE", 503]] as const) {
    const { handler } = handlerWith({ readLiveness: async () => canaryDone },
      { NOTIF_LIVENESS_EXPECT_ARMED: val as string | undefined });
    assertEquals((await handler(authed())).status, status, `EXPECT_ARMED=${String(val)}`);
  }
});

Deno.test("handler: every response carries JSON content-type and no-store", async () => {
  const cases: Array<() => Promise<Response>> = [
    () => handlerWith().handler(new Request("https://x/")),                                  // 401
    () => handlerWith({}, { SUPABASE_URL: undefined }).handler(authed()),                     // 503
    () => handlerWith({ readLiveness: () => Promise.reject(new Error("x")) }).handler(authed()), // 503
    () => handlerWith().handler(authed()),                                                    // 200
  ];
  for (const make of cases) {
    const res = await make();
    assertEquals(res.headers.get("content-type"), "application/json");
    assertEquals(res.headers.get("cache-control"), "no-store");
  }
});

Deno.test("handler: the x-monitor-token header authenticates too", async () => {
  const { handler } = handlerWith();
  assertEquals((await handler(new Request("https://x/", { headers: { "x-monitor-token": TOKEN } }))).status, 200);
});

Deno.test("firstRow / resolveStaleAfter are correct in isolation", () => {
  assertEquals(firstRow(null), null);
  assertEquals(firstRow([]), null);
  assertEquals(firstRow("nope"), null);
  assertEquals(firstRow(OK_ROW), OK_ROW);
  assertEquals(firstRow([OK_ROW]), OK_ROW);
  assertEquals(resolveStaleAfter(undefined), DEFAULT_STALE_AFTER_SECONDS);
  assertEquals(resolveStaleAfter(""), DEFAULT_STALE_AFTER_SECONDS);
  assertEquals(resolveStaleAfter("0"), DEFAULT_STALE_AFTER_SECONDS);
  assertEquals(resolveStaleAfter("-1"), DEFAULT_STALE_AFTER_SECONDS);
  assertEquals(resolveStaleAfter("abc"), DEFAULT_STALE_AFTER_SECONDS);
  assertEquals(resolveStaleAfter("60"), 60);
});
