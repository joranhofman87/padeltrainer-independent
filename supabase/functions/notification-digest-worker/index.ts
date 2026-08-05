// PR 10c-a3 — the digest WORKER (cron-driven, INERT until enabled). It drives the ADR-0008 SQL state machine
// (materialize → claim → per-state dispatch → ONE Resend call → record → sweep → finish) via the SECURITY
// DEFINER RPCs only. All atomicity / ownership / backoff / breaker / concurrency policy lives in the SQL; this
// is a thin, bounded, PII-free driver. Auth + config gating + status codes live in the injectable entry/handler.
//
// INERT by default: the DIGEST_SEND_ENABLED kill switch is off, so a disabled invocation returns 200 having
// made ZERO database calls. Enabling is a 10c-b step (schedule cron + flip the switch + enable one
// digest_engine_enabled event) behind a new review.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireServiceRole } from "../_shared/auth.ts";
import { notifySlackEdge } from "../_shared/edge-slack.ts";
import { sendResendEmailOnce } from "../_shared/resend-send-once.ts";
import { runDigestWorker, type WorkerLimits, type ReconcileMetric } from "../_shared/digest-worker-core.ts";
import { makeDigestWorkerEntry } from "../_shared/digest-worker-entry.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const CHANNEL = "email";
const DEFAULT_FROM = "PadelTrainer.ai <noreply@app.padeltrainer.ai>";

const LIMITS: WorkerLimits = {
  maxMaterializeGroups: 200,
  maxMaterializeMembers: 5000,
  maxAttempts: 100,
  sweepLimit: 500,
  // 10c-b E — orphan provider events drained per invocation. Bounded well under the sweep so a
  // large backlog costs a few extra ticks rather than the whole wall clock; `has_more` is logged
  // so a queue that never drains is visible.
  orphanReconcileLimit: 200,
  wallClockMs: 25_000,
};

const entry = makeDigestWorkerEntry({
  env: (k) => Deno.env.get(k),
  requireServiceRole,
  log: (event) => console.log(JSON.stringify(event)),
  // best-effort ops alert — notifySlackEdge never throws and no-ops if config/secret is absent.
  alert: (payload) => notifySlackEdge("digest_worker_alert", payload),
  corsHeaders,
  run: ({ resendApiKey, supabaseUrl, serviceKey, invocationId }) => {
    const supabase = createClient(supabaseUrl, serviceKey);
    return runDigestWorker({
      enabled: true,
      apiKeyPresent: true,
      channel: CHANNEL,
      from: DEFAULT_FROM,
      limits: LIMITS,
      // the deliberate invocation THIS request names, from the body the scheduled command built
      invocationId,
      rpc: async (name, args) => {
        const { data, error } = await supabase.rpc(name, args);
        if (error) throw new Error(`${name} rpc failed`); // no args/data in the message — PII-free
        return data;
      },
      readGroupState: async (groupId) => {
        const { data, error } = await supabase
          .from("notification_digest_groups").select("state").eq("id", groupId).maybeSingle();
        if (error) throw new Error("readGroupState failed");
        return (data?.state as string | undefined) ?? null;
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
        return { request: data.frozen_request as { from: string; to: string; subject: string; html: string }, idempotencyKey: data.provider_idempotency_key as string };
      },
      reconcile: async (runId) => {
        const { data, error } = await supabase.rpc("reconcile_notification_digest_run", { p_run_id: runId });
        if (error) throw new Error("reconcile rpc failed");
        return (data ?? []) as ReconcileMetric[];
      },
      sendOnce: (payload, opts) => sendResendEmailOnce(resendApiKey, payload, opts),
      now: () => new Date(),
      monotonicNowMs: () => performance.now(),
      newToken: () => `notification-digest-worker:${crypto.randomUUID()}`,
      log: (event) => console.log(JSON.stringify(event)),
    });
  },
});

serve(entry);
