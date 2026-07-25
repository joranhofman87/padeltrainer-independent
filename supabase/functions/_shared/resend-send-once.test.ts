import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseRetryAfterSeconds, sendResendEmailOnce } from "./resend-send-once.ts";

const PAYLOAD = { from: "PadelTrainer.ai <noreply@app.padeltrainer.ai>", to: ["p@example.com"], subject: "s", html: "<p>x</p>" };
const KEY = "dg:v1:11111111-1111-1111-1111-111111111111";

function fakeFetch(res: { status: number; body?: unknown; headers?: Record<string, string> }) {
  return (_url: string, _init: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify(res.body ?? {}), {
      status: res.status,
      headers: res.headers ?? {},
    }));
}

Deno.test("2xx accepted → response with provider message id, no error", async () => {
  const r = await sendResendEmailOnce("k", PAYLOAD, { idempotencyKey: KEY, fetchImpl: fakeFetch({ status: 202, body: { id: "re_abc" } }) });
  assertEquals(r, { kind: "response", httpStatus: 202, providerMessageId: "re_abc", errorName: null, retryAfterSeconds: null });
});

Deno.test("2xx WITHOUT a usable email id → 'no_response' transport (never a false accepted)", async () => {
  // empty body {}, blank id, non-string id, and unparseable JSON must all map to no_response — a bare
  // "accepted" without a provider id would make record_notification_digest_result raise.
  for (const body of [{}, { id: "" }, { id: "   " }, { id: 12345 }, { id: null }] as unknown[]) {
    const r = await sendResendEmailOnce("k", PAYLOAD, { idempotencyKey: KEY, fetchImpl: fakeFetch({ status: 202, body }) });
    assertEquals(r.kind, "transport");
    if (r.kind === "transport") assertEquals(r.transport, "no_response");
  }
  // unparseable 2xx body (invalid JSON) → also no_response
  const badJson = (_url: string, _init: RequestInit) =>
    Promise.resolve(new Response("<<not json>>", { status: 200 }));
  const r = await sendResendEmailOnce("k", PAYLOAD, { idempotencyKey: KEY, fetchImpl: badJson });
  assertEquals(r.kind, "transport");
  if (r.kind === "transport") assertEquals(r.transport, "no_response");
});

Deno.test("exactly ONE HTTP call is made (no internal retries)", async () => {
  let calls = 0;
  const counting = (_url: string, _init: RequestInit) => {
    calls++;
    return Promise.resolve(new Response(JSON.stringify({ id: "re_x" }), { status: 202 }));
  };
  await sendResendEmailOnce("k", PAYLOAD, { idempotencyKey: KEY, fetchImpl: counting });
  assertEquals(calls, 1);
});

Deno.test("422 validation → error_name from body.name, no provider id", async () => {
  const r = await sendResendEmailOnce("k", PAYLOAD, { idempotencyKey: KEY, fetchImpl: fakeFetch({ status: 422, body: { name: "validation_error", message: "bad" } }) });
  assertEquals(r, { kind: "response", httpStatus: 422, providerMessageId: null, errorName: "validation_error", retryAfterSeconds: null });
});

Deno.test("429 rate limit → error_name + Retry-After seconds surfaced", async () => {
  const r = await sendResendEmailOnce("k", PAYLOAD, { idempotencyKey: KEY, fetchImpl: fakeFetch({ status: 429, body: { name: "rate_limit_exceeded" }, headers: { "Retry-After": "30" } }) });
  assertEquals(r, { kind: "response", httpStatus: 429, providerMessageId: null, errorName: "rate_limit_exceeded", retryAfterSeconds: 30 });
});

Deno.test("error body without name falls back to http_<status>", async () => {
  const r = await sendResendEmailOnce("k", PAYLOAD, { idempotencyKey: KEY, fetchImpl: fakeFetch({ status: 500, body: {} }) });
  assertEquals(r.kind, "response");
  if (r.kind === "response") assertEquals(r.errorName, "http_500");
});

Deno.test("timeout (AbortError) → transport 'timeout'", async () => {
  const hangingFetch = (_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        const e = new Error("aborted"); e.name = "AbortError"; reject(e);
      });
    });
  const r = await sendResendEmailOnce("k", PAYLOAD, { idempotencyKey: KEY, timeoutMs: 5, fetchImpl: hangingFetch });
  assertEquals(r.kind, "transport");
  if (r.kind === "transport") assertEquals(r.transport, "timeout");
});

Deno.test("network error → transport 'network'", async () => {
  const boom = (_url: string, _init: RequestInit) => Promise.reject(new TypeError("connection refused"));
  const r = await sendResendEmailOnce("k", PAYLOAD, { idempotencyKey: KEY, fetchImpl: boom });
  assertEquals(r.kind, "transport");
  if (r.kind === "transport") assertEquals(r.transport, "network");
});

Deno.test("the Idempotency-Key header is the group's provider_idempotency_key", async () => {
  let seenKey: string | null = null;
  const capture = (_url: string, init: RequestInit) => {
    seenKey = (init.headers as Record<string, string>)["Idempotency-Key"];
    return Promise.resolve(new Response(JSON.stringify({ id: "re_1" }), { status: 202 }));
  };
  await sendResendEmailOnce("k", PAYLOAD, { idempotencyKey: KEY, fetchImpl: capture });
  assertEquals(seenKey, KEY);
});

Deno.test("parseRetryAfterSeconds: delta-seconds, HTTP-date, and invalid", () => {
  const now = Date.parse("2026-07-01T10:00:00Z");
  assertEquals(parseRetryAfterSeconds("120", now), 120);
  assertEquals(parseRetryAfterSeconds("Wed, 01 Jul 2026 10:02:00 GMT", now), 120);
  assertEquals(parseRetryAfterSeconds(null, now), null);
  assertEquals(parseRetryAfterSeconds("garbage", now), null);
  assertEquals(parseRetryAfterSeconds("Wed, 01 Jul 2026 09:59:00 GMT", now), 0); // past date clamps to 0
});
