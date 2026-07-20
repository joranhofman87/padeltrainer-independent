// Notification Foundation v2 — PR 9: the WhatsApp worker (cron-driven outbox drainer).
//
// Same skeleton as notification-email-worker (PR 4) — service-role guard → single-flight cron
// lock → claim a batch under a per-run lock token → per row: guard, send, record — reusing the
// SAME channel-parameterized RPCs. What differs is that every guard here refuses by default:
//
//   DISABLED UNTIL EXPLICITLY ENABLED. WHATSAPP_SEND_ENABLED must be exactly "true". Until
//   then this function returns without CLAIMING anything, so rows stay pending with their
//   attempt budget intact instead of being burned down to failed by a worker that cannot send.
//   That is the mechanical form of "do not send WhatsApp messages until credentials are
//   confirmed" — a flag, not a promise.
//
//   CONSENT IS RE-CHECKED AT SEND TIME. The resolver checked it at enqueue; a STOP may have
//   arrived since. An error on that check does NOT send.
//
//   NO APPROVED TEMPLATE => NO SEND. Business-initiated WhatsApp requires a Meta-approved
//   Content template; a missing SID is a config gap, so it backs off (self-heals once set)
//   rather than failing the row terminally.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireServiceRole } from "../_shared/auth.ts";
import { notifySlackEdgeError } from "../_shared/edge-slack.ts";
import { sendWhatsAppMessage } from "../_shared/whatsapp-send.ts";
import { buildContentVariables, templateForEvent } from "../_shared/whatsapp-templates.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const JOB = "notification-whatsapp-worker";
const BATCH_LIMIT = 25;
const E164 = /^\+[1-9][0-9]{7,14}$/;

type ClaimedRow = {
  outbox_id: string;
  event_type: string;
  template_key: string | null;
  destination_normalized: string | null;
  destination_redacted: string | null;
  payload: {
    language?: string;
    /** Named values for the template's positional contract. */
    variables?: Record<string, string>;
    /** Free-form text; only deliverable inside the 24h service window. */
    body?: string;
  } | null;
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

  let cronLockHeld = false;
  try {
    const guard = requireServiceRole(req);
    if (guard) return guard;

    // THE KILL SWITCH. Checked before the claim on purpose: claiming and then failing would
    // increment attempts on every pending row each tick and eventually mark them failed —
    // destroying the queue we are trying to protect.
    if (Deno.env.get("WHATSAPP_SEND_ENABLED") !== "true") {
      return json({ processed: 0, skipped: "disabled" });
    }

    const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
    const auth = {
      accountSid,
      apiKeySid: Deno.env.get("TWILIO_API_SID") ?? undefined,
      apiKeySecret: Deno.env.get("TWILIO_API_CLIENT_SECRET") ?? undefined,
      authToken: Deno.env.get("TWILIO_AUTH_TOKEN") ?? undefined,
    };
    const sender = Deno.env.get("TWILIO_MESSAGING_SERVICE_SID") || Deno.env.get("TWILIO_WHATSAPP_FROM") || "";
    if (!accountSid || !sender) {
      // Config gap: return before claiming, for the same reason as the kill switch.
      return json({ error: "twilio sender not configured", processed: 0 }, 500);
    }
    const statusCallback = Deno.env.get("TWILIO_STATUS_CALLBACK_URL") || undefined;
    const allowFreeform = Deno.env.get("WHATSAPP_ALLOW_FREEFORM") === "true";

    const { data: cronLocked } = await supabase.rpc("try_lock_cron_job", { p_job_name: JOB });
    if (cronLocked === false) return json({ processed: 0, skipped: "locked" });
    cronLockHeld = cronLocked === true;

    const { data: claimed, error: claimErr } = await supabase.rpc("claim_notification_outbox_batch", {
      p_channel: "whatsapp",
      p_worker: workerToken,
      p_limit: BATCH_LIMIT,
    });
    if (claimErr) throw new Error(`claim failed: ${claimErr.message}`);

    const rows = (claimed ?? []) as ClaimedRow[];
    let sent = 0;
    let failed = 0;
    let refused = 0;   // guard-refused: never reached Twilio

    for (const row of rows) {
      const dest = (row.destination_normalized ?? "").trim();
      const payload = row.payload ?? {};

      // 1. destination must be strict E.164. The contact was normalized at opt-in, so a bad
      //    value here means the row can never be sent — terminal, not a retry.
      if (!E164.test(dest)) {
        await recordResult(row.outbox_id, "failed", { error: "invalid_phone", terminal: true });
        refused++;
        continue;
      }

      // 2. send-time consent re-check. FAIL CLOSED: an error means we do NOT send, and retry
      //    later — the opposite default would message someone who may have said STOP.
      let consented: boolean | null = null;
      let consentErr: unknown = null;
      try {
        const res = await supabase.rpc("whatsapp_consent_active", { p_phone: dest });
        consented = res.data as boolean | null;
        consentErr = res.error;
      } catch (e) {
        consentErr = e;
      }
      if (consentErr) {
        await recordResult(row.outbox_id, "failed", { error: "consent_check_failed", terminal: false });
        failed++;
        continue;
      }
      if (consented !== true) {
        // Withdrawn (or never granted) consent is permanent for this row: a later opt-in
        // enqueues new notifications, it does not resurrect this one.
        await recordResult(row.outbox_id, "failed", { error: "whatsapp_not_consented", terminal: true });
        refused++;
        continue;
      }

      // 3. resolve the committed template for this event.
      const template = templateForEvent(row.event_type, payload.language ?? "nl");
      const contentSid = template ? Deno.env.get(template.contentSidEnv) : undefined;
      const contentVariables = template
        ? buildContentVariables(template, payload.variables ?? {})
        : undefined;

      if (!template) {
        // No committed template for this event/language — the row cannot be rendered at all.
        await recordResult(row.outbox_id, "failed", { error: "no_whatsapp_template", terminal: true });
        refused++;
        continue;
      }
      if (!contentSid && !(allowFreeform && payload.body)) {
        // The template exists but its approved SID is not configured yet. RETRYABLE: this is a
        // deployment gap that fixes itself the moment the env var is set, and a terminal
        // failure here would silently discard every reminder queued before approval landed.
        await recordResult(row.outbox_id, "failed", { error: "missing_content_sid", terminal: false });
        failed++;
        continue;
      }

      const outcome = await sendWhatsAppMessage(auth, {
        from: sender,
        to: dest,
        ...(contentSid ? { contentSid, contentVariables } : { body: payload.body }),
        ...(statusCallback ? { statusCallback } : {}),
      });

      if (outcome.ok) {
        await recordResult(row.outbox_id, "sent", { messageId: outcome.sid ?? null });
        sent++;
      } else {
        await recordResult(row.outbox_id, "failed", {
          error: outcome.error.slice(0, 500),
          terminal: !outcome.retryable,
        });
        failed++;
      }
    }

    if (failed > 0) {
      await notifySlackEdgeError(JOB, `${failed} WhatsApp notification(s) failed to send`, {
        failed,
        sent,
        refused,
      });
    }

    return json({ processed: rows.length, sent, failed, refused });
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
