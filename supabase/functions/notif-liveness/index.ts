// N7 step 3c — the EXTERNAL liveness surface for the digest worker.
//
// `public.notif_digest_worker_liveness()` is service_role-only, so nothing outside the platform can
// read it. This is the one place that does, behind its own credential, returning six PII-free
// operational facts and — the part that matters — a status code an uptime provider can alert on
// without being taught to parse anything.
//
// verify_jwt = false (config.toml): an uptime provider cannot carry a Supabase JWT. The
// NOTIF_LIVENESS_TOKEN is the auth, compared in constant time, and it fails CLOSED when unset.
//
// Every decision lives in _shared/notif-liveness-core.ts under Deno tests; this module ends in
// Deno.serve and is deliberately unimportable, so it contains nothing worth testing.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";
import {
  DEFAULT_STALE_AFTER_SECONDS,
  decideLiveness,
  isAuthorizedMonitor,
  livenessBody,
  type LivenessRow,
} from "../_shared/notif-liveness-core.ts";

const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };

Deno.serve(async (req) => {
  if (!await isAuthorizedMonitor(req, Deno.env.get("NOTIF_LIVENESS_TOKEN"))) {
    // No detail: an unauthenticated caller learns nothing about whether the endpoint is configured.
    return new Response(JSON.stringify({ ok: false, state: "unauthorized" }), { status: 401, headers: JSON_HEADERS });
  }

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    // A misconfigured monitor must not read as healthy.
    return new Response(JSON.stringify({ ok: false, state: "misconfigured", detail: "supabase env missing" }), { status: 503, headers: JSON_HEADERS });
  }

  const staleAfter = Number(Deno.env.get("NOTIF_LIVENESS_STALE_SECONDS") ?? DEFAULT_STALE_AFTER_SECONDS);

  let row: LivenessRow | null = null;
  try {
    const { data, error } = await createClient(url, key).rpc("notif_digest_worker_liveness");
    if (error) throw new Error(error.message);
    row = (Array.isArray(data) ? data[0] : data) as LivenessRow ?? null;
  } catch (e) {
    // "the status query itself fails" is one of the four states the monitor must catch, so it is a
    // 503 and never a 2xx — an outage that reads as healthy is worse than no monitor at all.
    //
    // The downstream message is LOGGED, not returned. A raw error string is arbitrary text from
    // another system; it can quote a row, a column value or a connection string, and this response
    // goes to a third-party uptime provider. The external body says only that the read failed —
    // which is all a monitor needs to alert on.
    console.error("notif-liveness: liveness read failed:", e instanceof Error ? e.message : String(e));
    return new Response(
      JSON.stringify({ ok: false, state: "query_failed", detail: "the liveness read failed; see function logs" }),
      { status: 503, headers: JSON_HEADERS },
    );
  }

  if (!row) {
    return new Response(JSON.stringify({ ok: false, state: "query_failed", detail: "liveness returned no row" }), { status: 503, headers: JSON_HEADERS });
  }

  // The operator declares activation; the row cannot be asked, because a successful canary and a
  // disarmed live cron look identical in it. Flipped as part of runbook step 7.
  const expectArmed = (Deno.env.get("NOTIF_LIVENESS_EXPECT_ARMED") ?? "").toLowerCase() === "true";
  const verdict = decideLiveness(
    row,
    Number.isFinite(staleAfter) && staleAfter > 0 ? staleAfter : DEFAULT_STALE_AFTER_SECONDS,
    expectArmed,
  );
  return new Response(JSON.stringify(livenessBody(row, verdict)), { status: verdict.httpStatus, headers: JSON_HEADERS });
});
