// Notification Foundation v2 — PR 4: the email worker (cron-driven outbox drainer).
// See docs/NOTIFICATION_ARCHITECTURE.md §2 (worker). Thin send loop; all the
// atomicity/backoff/ownership policy lives in the SECURITY DEFINER RPCs from migration
// 20260912100000 (claim_notification_outbox_batch / record_notification_send_result
// / claim_skipped_required_alerts / mark_skipped_alerts_sent).
//
// Flow: service-role guard → single-flight cron lock → claim a batch of due (or stale-
// orphaned) email rows under a PER-RUN lock token → per row: validate payload, re-check
// suppression (FAIL CLOSED), send via Resend (provider-idempotent), record the outcome
// under our token → lease + confirm the ops Slack alert on skipped-required rows.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { evaluateInstantSendGate } from "../_shared/instant-send-gate.ts";
import { checkChannelKillOrRelease } from "../_shared/channel-kill-check.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";
import { sendResendEmail } from "../_shared/resend-send.ts";
import { requireServiceRole } from "../_shared/auth.ts";
import { notifySlackEdgeError, notifySlackEdgeResult } from "../_shared/edge-slack.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const JOB = "notification-email-worker";
const DEFAULT_FROM = "PadelTrainer.ai <noreply@app.padeltrainer.ai>";
const BATCH_LIMIT = 25;
const ALERT_LIMIT = 25;

type ClaimedRow = {
  outbox_id: string;
  event_type: string;
  template_key: string | null;
  destination_normalized: string | null;
  destination_redacted: string | null;
  payload:
    | {
        subject?: string;
        html?: string;
        from?: string;
        // optional pass-through attachments (e.g. the paid-booking invoice PDF, built at
        // enqueue time so the payload is self-contained + retries are deterministic).
        attachments?: Array<{ filename: string; content: string }>;
      }
    | null;
  attempts: number;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // unique per invocation: it is the lock token, so only THIS run may finalize the rows
  // it claims. A stale-takeover by a later run gets a different token → our late writes no-op.
  const workerToken = `${JOB}:${crypto.randomUUID()}`;

  const recordResult = (
    outboxId: string,
    status: "sent" | "failed",
    opts: { messageId?: string | null; error?: string; terminal?: boolean } = {},
  ) =>
    supabase.rpc("record_notification_send_result", {
      p_outbox_id: outboxId,
      p_worker: workerToken,
      p_status: status,
      p_provider_message_id: opts.messageId ?? null,
      p_error: opts.error ?? null,
      p_terminal: opts.terminal ?? false,
    });

  try {
    const guard = requireServiceRole(req);
    if (guard) return guard;

    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (!resendApiKey) return json({ error: "RESEND_API_KEY not configured" }, 500);

    // NO cron single-flight lock (10c-b/CRON-SF-WEDGE). The session-scoped
    // try_lock_cron_job pair was removed: it spanned many pooled PostgREST requests
    // with no session affinity, so its unlock could land on a different backend and
    // wedge this job until that connection recycled. Nothing is lost — the atomic
    // claim below IS the concurrency boundary: claim_notification_outbox_batch takes
    // rows FOR UPDATE SKIP LOCKED and stamps this run's worker token on each, so two
    // concurrent invocations claim DISJOINT rows and cannot duplicate a send, and
    // record_notification_send_result is token-guarded so a superseded run's late
    // write no-ops. (The old comment here already conceded the claim was the real guard.)

    // 1. atomically claim due (or stale-orphaned) email rows under our lock token
    const { data: claimed, error: claimErr } = await supabase.rpc("claim_notification_outbox_batch", {
      p_channel: "email",
      p_worker: workerToken,
      p_limit: BATCH_LIMIT,
    });
    if (claimErr) throw new Error(`claim failed: ${claimErr.message}`);

    const rows = (claimed ?? []) as ClaimedRow[];
    let sent = 0;
    let failed = 0;
    let suppressed = 0;
    let deferred = 0;

    for (const row of rows) {
      // N4 M2 — the pre-provider KILL re-check, top of EVERY iteration and fail-closed: the
      // claim-time gate cannot stop rows claimed before the kill landed, and a kill means mail
      // stops NOW. On kill (or an unreadable check) release everything still held — attempts
      // given back, nothing terminal — and end the loop.
      const kill = await checkChannelKillOrRelease(
        async (name, args) => await supabase.rpc(name, args),
        "email",
        workerToken,
      );
      if (kill.killed) {
        deferred = kill.released;
        console.log(JSON.stringify({ event: "channel_killed", channel: "email", reason: kill.reason, released: kill.released }));
        break;
      }
      // THE SEND GATE lives in _shared/instant-send-gate.ts so it can be tested directly:
      // renderability -> suppression -> the COMPLETE live policy, all fail-closed. The handler
      // only executes the verdict, so the check order and terminal-ness cannot regress unseen.
      const payload = row.payload ?? {};
      const verdict = await evaluateInstantSendGate(row, {
        isEmailSuppressed: async (email) => {
          const r = await supabase.rpc("is_email_suppressed", { p_email: email });
          return { data: r.data as boolean | null, error: r.error };
        },
        memberStopReason: async (outboxId) => {
          const r = await supabase.rpc("notif_digest_member_stop_reason", { p_member_id: outboxId });
          return { data: r.data as string | null, error: r.error };
        },
      });
      if (verdict.action === "stop") {
        await recordResult(row.outbox_id, "failed", {
          error: verdict.error,
          terminal: verdict.terminal,
        });
        if (verdict.countAs === "suppressed") suppressed++; else failed++;
        continue;
      }
      const { dest, subject, html } = verdict;

      // provider-idempotent: keyed on the stable outbox id → a retry after Resend already
      // accepted the send (our timeout, a stale takeover) is a no-op in Resend's 24h window.
      const outcome = await sendResendEmail(
        resendApiKey,
        {
          from: payload.from ?? DEFAULT_FROM,
          to: [dest],
          subject,
          html,
          ...(payload.attachments && payload.attachments.length > 0
            ? { attachments: payload.attachments }
            : {}),
        },
        { idempotencyKey: `notification-outbox-${row.outbox_id}` },
      );

      if (outcome.ok) {
        await recordResult(row.outbox_id, "sent", { messageId: outcome.id ?? null });
        sent++;
      } else {
        // non-retryable Resend errors (4xx) are terminal; retryable ones (429/5xx/network) back off
        await recordResult(row.outbox_id, "failed", {
          error: outcome.error.slice(0, 500),
          terminal: !outcome.retryable,
        });
        failed++;
      }
    }

    // 2. PR-3 hand-off: the ops Slack alert on skipped-required rows. LEASE → send →
    // confirm: only mark alerted after Slack succeeds, so a Slack failure re-tries later.
    let alerted = 0;
    const { data: leased } = await supabase.rpc("claim_skipped_required_alerts", { p_limit: ALERT_LIMIT });
    const alerts = (leased ?? []) as Array<{ outbox_id: string; event_type: string; skip_reason: string | null }>;
    if (alerts.length > 0) {
      const ok = await notifySlackEdgeResult("edge_function_error", {
        function: JOB,
        error: `${alerts.length} required notification(s) had no deliverable channel`,
        count: alerts.length,
        // SAFE refs only — never a destination/PII in an ops alert
        samples: alerts.slice(0, 10).map((a) => ({ event: a.event_type, reason: a.skip_reason, outbox_id: a.outbox_id })),
      });
      if (ok) {
        await supabase.rpc("mark_skipped_alerts_sent", { p_ids: alerts.map((a) => a.outbox_id) });
        alerted = alerts.length;
      }
    }

    // per-row failures return HTTP 200 (only non-2xx trips the cron wrapper), so alert here
    if (failed > 0) {
      await notifySlackEdgeError(JOB, `${failed} email notification(s) failed to send`, { failed, sent, suppressed });
    }

    return json({ processed: rows.length, sent, failed, suppressed, deferred, alerted });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    try {
      await notifySlackEdgeError(JOB, msg);
    } catch {
      // alerting is best-effort — never mask the original error
    }
    return json({ error: msg }, 500);
  }
};

serve(handler);
