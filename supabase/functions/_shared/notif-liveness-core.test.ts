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

Deno.test("detects: the worker was never invoked (cron armed, no success behind it)", () => {
  const v = decideLiveness(row({ job_active: true, last_success_at: null }));
  assertEquals(v.state, "never_invoked");
  assertEquals(v.httpStatus, 503);
});

Deno.test("detects: last_success_at has gone stale", () => {
  const v = decideLiveness(row({
    job_active: true,
    last_success_at: "2026-08-07T00:00:00Z",
    seconds_since_success: DEFAULT_STALE_AFTER_SECONDS + 1,
  }));
  assertEquals(v.state, "stale");
  assertEquals(v.httpStatus, 503);
});

Deno.test("detects: the cron is missing", () => {
  const v = decideLiveness(row({ job_present: false }));
  assertEquals(v.state, "cron_missing");
  assertEquals(v.httpStatus, 503);
});

Deno.test("detects: the cron went INACTIVE after activation", () => {
  // The distinguishing fact is that it succeeded before — otherwise this is the inert state.
  const v = decideLiveness(row({ job_active: false, last_success_at: "2026-08-07T00:00:00Z", seconds_since_success: 60 }));
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
  const v = decideLiveness(row({ job_active: true, last_success_at: "2026-08-07T00:00:00Z", seconds_since_success: 120 }));
  assertEquals(v.state, "live");
  assertEquals(v.httpStatus, 200);
});

Deno.test("the threshold boundary is exclusive — exactly at it is still live", () => {
  const at = decideLiveness(row({ job_active: true, last_success_at: "x", seconds_since_success: DEFAULT_STALE_AFTER_SECONDS }));
  assertEquals(at.state, "live");
  const over = decideLiveness(row({ job_active: true, last_success_at: "x", seconds_since_success: DEFAULT_STALE_AFTER_SECONDS + 0.001 }));
  assertEquals(over.state, "stale");
});

Deno.test("an unusable age fails CLOSED rather than reporting live", () => {
  for (const bad of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
    const v = decideLiveness(row({ job_active: true, last_success_at: "x", seconds_since_success: bad as number | null }));
    assertEquals(v.state, "stale", `age ${String(bad)} must not read as live`);
    assertEquals(v.httpStatus, 503);
  }
});

Deno.test("a custom threshold is honoured", () => {
  const v = decideLiveness(row({ job_active: true, last_success_at: "x", seconds_since_success: 100 }), 60);
  assertEquals(v.state, "stale");
});

// ── authorization ───────────────────────────────────────────────────────────────────────────────

Deno.test("authorizes nobody when no token is configured (fails closed)", () => {
  const req = new Request("https://x/", { headers: { authorization: "Bearer anything" } });
  assertFalse(isAuthorizedMonitor(req, undefined));
  assertFalse(isAuthorizedMonitor(req, ""));
});

Deno.test("accepts the token as Bearer or x-monitor-token, and rejects a wrong one", () => {
  const tok = "s3cret-monitor-token";
  assert(isAuthorizedMonitor(new Request("https://x/", { headers: { authorization: `Bearer ${tok}` } }), tok));
  assert(isAuthorizedMonitor(new Request("https://x/", { headers: { "x-monitor-token": tok } }), tok));
  assertFalse(isAuthorizedMonitor(new Request("https://x/", { headers: { authorization: "Bearer wrong" } }), tok));
  assertFalse(isAuthorizedMonitor(new Request("https://x/"), tok));
});

Deno.test("timingSafeEqual is length-safe and value-correct", () => {
  assert(timingSafeEqual("abc", "abc"));
  assertFalse(timingSafeEqual("abc", "abd"));
  assertFalse(timingSafeEqual("abc", "abcd"));
  assertFalse(timingSafeEqual("", "a"));
});

// ── the body must stay PII-free ─────────────────────────────────────────────────────────────────

Deno.test("the response body exposes ONLY operational fields — no recipient data", () => {
  const r = row({ job_active: true, last_success_at: "2026-08-07T00:00:00Z", seconds_since_success: 5, last_status: "succeeded" });
  const body = livenessBody(r, decideLiveness(r));
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
