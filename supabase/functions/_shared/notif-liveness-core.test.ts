import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DEFAULT_STALE_AFTER_SECONDS,
  decideLiveness,
  isAuthorizedMonitor,
  livenessBody,
  timingSafeEqual,
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
