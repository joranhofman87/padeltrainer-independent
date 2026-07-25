// PR 10c-a3 — the digest WORKER (cron-driven, INERT until enabled). It drives the ADR-0008 SQL state machine
// (materialize → claim → prepare → render → split/terminalize-oversize → store → begin → ONE Resend call →
// record → sweep → finish) via the SECURITY DEFINER RPCs only. All the atomicity / ownership / backoff /
// breaker policy lives in the SQL; this is a thin, bounded, PII-free driver.
//
// INERT by default: the DIGEST_SEND_ENABLED kill switch is off, so a disabled invocation returns having made
// ZERO database calls (no run, no claim, no mutation) — validated BEFORE the single-flight lock. Enabling is a
// 10c-b step (schedule cron + flip the switch + enable one digest_engine_enabled event) behind a new review.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireServiceRole } from "../_shared/auth.ts";
import { sendResendEmailOnce } from "../_shared/resend-send-once.ts";
import { runDigestWorker, type WorkerLimits } from "../_shared/digest-worker-core.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const JOB = "notification-digest-worker";
const CHANNEL = "email";
const DEFAULT_FROM = "PadelTrainer.ai <noreply@app.padeltrainer.ai>";

const LIMITS: WorkerLimits = {
  maxMaterializeGroups: 200,
  maxMaterializeMembers: 5000,
  maxAttempts: 100,
  sweepLimit: 500,
  wallClockMs: 25_000,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const guard = requireServiceRole(req);
  if (guard) return guard;

  // req 1 — INERT unless enabled AND configured, checked BEFORE any DB call (incl. the single-flight lock).
  const enabled = Deno.env.get("DIGEST_SEND_ENABLED") === "true";
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  if (!enabled || !resendApiKey) {
    console.log(JSON.stringify({ event: "digest_worker_skipped", reason: !enabled ? "disabled" : "no_api_key" }));
    return json({ status: "disabled", reason: !enabled ? "disabled" : "no_api_key" });
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // single-flight: skip this tick if another run holds the lock (fail-open — the atomic claim is the real guard).
  const { data: cronLocked } = await supabase.rpc("try_lock_cron_job", { p_job_name: JOB });
  if (cronLocked === false) return json({ status: "locked" });

  try {
    const summary = await runDigestWorker({
      enabled: true,
      apiKeyPresent: true,
      channel: CHANNEL,
      from: DEFAULT_FROM,
      limits: LIMITS,
      rpc: async (name, args) => {
        const { data, error } = await supabase.rpc(name, args);
        if (error) throw new Error(`${name} rpc failed`); // no args/data in the message — PII-free
        return data;
      },
      loadMembers: async (groupId) => {
        const { data, error } = await supabase
          .from("notification_outbox")
          .select("destination_normalized, digest_item, group_locale")
          .eq("digest_group_id", groupId).eq("status", "pending")
          .order("created_at", { ascending: true }).order("id", { ascending: true });
        if (error) throw new Error("loadMembers failed");
        return (data ?? []).map((r) => ({ destination: r.destination_normalized as string, digestItem: r.digest_item, locale: (r.group_locale as string | null) ?? null }));
      },
      loadFrozen: async (groupId) => {
        const { data, error } = await supabase
          .from("notification_digest_groups")
          .select("frozen_request, provider_idempotency_key")
          .eq("id", groupId).maybeSingle();
        if (error) throw new Error("loadFrozen failed");
        if (!data || !data.frozen_request || !data.provider_idempotency_key) return null;
        return { request: data.frozen_request as { to: string; subject: string; html: string }, idempotencyKey: data.provider_idempotency_key as string };
      },
      sendOnce: (payload, opts) => sendResendEmailOnce(resendApiKey, payload, opts),
      now: () => new Date(),
      monotonicNowMs: () => performance.now(),
      newToken: () => `${JOB}:${crypto.randomUUID()}`,
      log: (event) => console.log(JSON.stringify(event)),
    });
    return json(summary, summary.status === "error" ? 500 : 200);
  } catch {
    // runDigestWorker already finished the run 'failed' and logged a redacted error before rethrowing.
    console.log(JSON.stringify({ event: "digest_worker_invocation_error" }));
    return json({ status: "error" }, 500);
  } finally {
    await supabase.rpc("unlock_cron_job", { p_job_name: JOB });
  }
};

serve(handler);
