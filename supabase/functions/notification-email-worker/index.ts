// Notification Foundation v2 — PR 4: the email worker (cron-driven outbox drainer).
// See docs/NOTIFICATION_ARCHITECTURE.md §2 (worker). Thin send loop; all the
// atomicity/backoff policy lives in the SECURITY DEFINER RPCs from migration
// 20260912100000 (claim_notification_outbox_batch / record_notification_send_result
// / claim_skipped_required_alerts).
//
// Flow: service-role guard → single-flight cron lock → claim a batch of due email
// rows → per row: validate payload, re-check suppression, send via Resend, record
// the outcome (sent / retry-with-backoff / terminal) → raise the exactly-once ops
// Slack alert on skipped-required rows (the PR-3 hand-off) and on send failures.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendResendEmail } from "../_shared/resend-send.ts";
import { requireServiceRole } from "../_shared/auth.ts";
import { notifySlackEdgeError } from "../_shared/edge-slack.ts";

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
  payload: { subject?: string; html?: string; from?: string } | null;
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

  let cronLockHeld = false;
  try {
    // only pg_cron / service-role callers (constant-time key comparison)
    const guard = requireServiceRole(req);
    if (guard) return guard;

    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (!resendApiKey) return json({ error: "RESEND_API_KEY not configured" }, 500);

    // single-flight: skip this tick if another run holds the lock. Fail-open — an RPC
    // error leaves cronLockHeld=false and we proceed (the atomic claim is the real guard).
    const { data: cronLocked } = await supabase.rpc("try_lock_cron_job", { p_job_name: JOB });
    if (cronLocked === false) return json({ processed: 0, skipped: "locked" });
    cronLockHeld = cronLocked === true;

    // 1. atomically claim a batch of due email rows (marks them processing, bumps attempts)
    const { data: claimed, error: claimErr } = await supabase.rpc("claim_notification_outbox_batch", {
      p_channel: "email",
      p_worker: JOB,
      p_limit: BATCH_LIMIT,
    });
    if (claimErr) throw new Error(`claim failed: ${claimErr.message}`);

    const rows = (claimed ?? []) as ClaimedRow[];
    let sent = 0;
    let failed = 0;
    let suppressed = 0;

    for (const row of rows) {
      const dest = (row.destination_normalized ?? "").trim();
      const payload = row.payload ?? {};
      const subject = payload.subject;
      const html = payload.html;

      // a row that can never render is terminal — never burn retries on it
      if (!dest || !subject || !html) {
        await supabase.rpc("record_notification_send_result", {
          p_outbox_id: row.outbox_id,
          p_status: "failed",
          p_error: !dest ? "missing_destination" : "missing_subject_or_html",
          p_terminal: true,
        });
        failed++;
        continue;
      }

      // suppression may have flipped since enqueue (a bounce/complaint webhook fired) →
      // don't send to a known-bad address; terminal (retrying just re-bounces).
      try {
        const { data: blocked } = await supabase.rpc("is_email_suppressed", { p_email: dest });
        if (blocked === true) {
          await supabase.rpc("record_notification_send_result", {
            p_outbox_id: row.outbox_id,
            p_status: "failed",
            p_error: "email_suppressed",
            p_terminal: true,
          });
          suppressed++;
          continue;
        }
      } catch {
        // suppression check is best-effort — fall through and attempt the send
      }

      const outcome = await sendResendEmail(resendApiKey, {
        from: payload.from ?? DEFAULT_FROM,
        to: [dest],
        subject,
        html,
      });

      if (outcome.ok) {
        await supabase.rpc("record_notification_send_result", {
          p_outbox_id: row.outbox_id,
          p_status: "sent",
          p_provider_message_id: outcome.id ?? null,
        });
        sent++;
      } else {
        // non-retryable Resend errors (4xx) are terminal; retryable ones (429/5xx/network) back off
        await supabase.rpc("record_notification_send_result", {
          p_outbox_id: row.outbox_id,
          p_status: "failed",
          p_error: outcome.error.slice(0, 500),
          p_terminal: !outcome.retryable,
        });
        failed++;
      }
    }

    // 2. PR-3 hand-off: raise the exactly-once ops Slack alert on skipped-required rows
    // (the resolver wrote the durable skipped row; SQL can't do outbound HTTP).
    let alerted = 0;
    const { data: skippedRows } = await supabase.rpc("claim_skipped_required_alerts", { p_limit: ALERT_LIMIT });
    const alerts = (skippedRows ?? []) as Array<{ outbox_id: string; event_type: string; skip_reason: string | null }>;
    if (alerts.length > 0) {
      alerted = alerts.length;
      await notifySlackEdgeError(
        JOB,
        `${alerts.length} required notification(s) had no deliverable channel`,
        {
          count: alerts.length,
          // SAFE refs only — never a destination/PII in an ops alert
          samples: alerts.slice(0, 10).map((a) => ({ event: a.event_type, reason: a.skip_reason, outbox_id: a.outbox_id })),
        },
      );
    }

    // per-row failures return HTTP 200 (only non-2xx trips the cron wrapper), so alert here
    if (failed > 0) {
      await notifySlackEdgeError(JOB, `${failed} email notification(s) failed to send`, { failed, sent, suppressed });
    }

    return json({ processed: rows.length, sent, failed, suppressed, alerted });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    try {
      await notifySlackEdgeError(JOB, msg);
    } catch {
      // alerting is best-effort — never mask the original error
    }
    return json({ error: msg }, 500);
  } finally {
    if (cronLockHeld) {
      try {
        await supabase.rpc("unlock_cron_job", { p_job_name: JOB });
      } catch {
        // best-effort: the lock is session-scoped and auto-releases when the connection recycles
      }
    }
  }
};

serve(handler);
