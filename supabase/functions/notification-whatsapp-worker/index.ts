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
//   Content template.
//
//   A GLOBAL CONFIG GAP DEFERS INSTEAD OF FAILING. Marking a missing template SID or a 401 as
//   a "retryable failure" is not enough: record_notification_send_result fails a row once
//   attempts >= max_attempts whatever p_terminal says, and 5 attempts of 2^n backoff is only
//   ~62 minutes — shorter than a credential fix or a Meta template review. Those rows are
//   deferred (attempt given back) so the gap parks the queue instead of destroying it.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";
import { requireServiceRole } from "../_shared/auth.ts";
import { notifySlackEdgeError } from "../_shared/edge-slack.ts";
import { sendWhatsAppMessage, whatsappFailureAction } from "../_shared/whatsapp-send.ts";
import { checkChannelKillOrRelease } from "../_shared/channel-kill-check.ts";
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
      p_provider: "twilio",   // the RPC also derives this from the channel; explicit is clearer
      p_terminal: opts.terminal ?? false,
    });

  // A GLOBAL config gap is not this row's fault and never reached the provider, so it must not
  // spend the row's attempt budget: record_notification_send_result fails a row once
  // attempts >= max_attempts regardless of p_terminal, which at 5 attempts of 2^n backoff is
  // ~62 minutes — far shorter than a credential fix or a Meta template approval. Deferring
  // parks the row until the config is corrected instead of burning it down.
  const deferRow = async (outboxId: string, reason: string): Promise<"deferred" | "exhausted"> => {
    const { data } = await supabase.rpc("defer_notification_outbox_row", {
      p_outbox_id: outboxId,
      p_worker: workerToken,
      p_reason: reason,
      p_retry_minutes: 5,
      p_max_defer_hours: 24,
    });
    // 'exhausted' = parked past the cap and now terminally failed; count it as a failure so it
    // is alerted as one rather than hiding inside the (benign-sounding) deferred tally.
    return data === "exhausted" ? "exhausted" : "deferred";
  };

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

    // NO cron single-flight lock (10c-b/CRON-SF-WEDGE). The session-scoped
    // try_lock_cron_job pair was removed: its unlock could land on a different
    // pooled backend than the lock and wedge this job indefinitely. The atomic
    // claim below IS the boundary — claim_notification_outbox_batch takes rows
    // FOR UPDATE SKIP LOCKED under this run's worker token, so concurrent
    // invocations claim disjoint rows and cannot duplicate a WhatsApp send.

    const { data: claimed, error: claimErr } = await supabase.rpc("claim_notification_outbox_batch", {
      p_channel: "whatsapp",
      p_worker: workerToken,
      p_limit: BATCH_LIMIT,
    });
    if (claimErr) throw new Error(`claim failed: ${claimErr.message}`);

    const rows = (claimed ?? []) as ClaimedRow[];
    let sent = 0;
    let failed = 0;
    let refused = 0;    // guard-refused: never reached Twilio, and never will
    let deferred = 0;   // parked on a GLOBAL config gap, with the attempt given back

    for (const row of rows) {
      // N4 M2 — the pre-provider KILL re-check, top of EVERY iteration and fail-closed (a read
      // error counts as killed): rows claimed before the kill landed must not reach Twilio.
      // On kill: release what this run still holds (attempts given back) and end the loop.
      const kill = await checkChannelKillOrRelease(
        async (name, args) => await supabase.rpc(name, args),
        "whatsapp",
        workerToken,
      );
      if (kill.killed) {
        deferred += kill.released;
        console.log(JSON.stringify({ event: "channel_killed", channel: "whatsapp", reason: kill.reason, released: kill.released }));
        break;
      }

      const dest = (row.destination_normalized ?? "").trim();
      const payload = row.payload ?? {};

      // 1. destination must be strict E.164. The contact was normalized at opt-in, so a bad
      //    value here means the row can never be sent — terminal, not a retry.
      if (!E164.test(dest)) {
        await recordResult(row.outbox_id, "failed", { error: "invalid_phone", terminal: true });
        refused++;
        continue;
      }

      // 2. send-time consent re-check, bound to THIS ROW'S OWN contact — not to the number.
      //    A number-keyed check would let this row ride a DIFFERENT person's consent on the
      //    same number (phone change + a spouse/new holder registering it). FAIL CLOSED: an
      //    error means we do NOT send, and retry later.
      let consented: boolean | null = null;
      let consentErr: unknown = null;
      try {
        const res = await supabase.rpc("whatsapp_outbox_consent_active", { p_outbox_id: row.outbox_id });
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
        // The template exists but its approved SID is not configured yet — a GLOBAL gap, not a
        // property of this row. DEFER rather than record a failure: a "retryable" failure still
        // consumes an attempt, so a template approval taking longer than ~62 minutes would
        // permanently discard every reminder queued behind it.
        if (await deferRow(row.outbox_id, "missing_content_sid") === "exhausted") failed++;
        else deferred++;
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
        // The defer/fail/retry policy lives in whatsappFailureAction so it is unit-testable;
        // this switch is only the wiring.
        const err = outcome.error.slice(0, 500);
        switch (whatsappFailureAction(outcome)) {
          case "defer":
            // Credentials, sender, or an unapproved/wrong-account ContentSid — all env-supplied,
            // so Twilio is rejecting our CONFIG, not this recipient. Park rather than destroy.
            if (await deferRow(row.outbox_id, err) === "exhausted") failed++;
            else deferred++;
            break;
          case "terminal_optout":
            // Twilio says this recipient unsubscribed. Before the status webhook is live this
            // is our ONLY signal of a STOP, so record the withdrawal — otherwise the resolver
            // keeps queueing messages that can never deliver, against someone who opted out.
            await supabase.rpc("record_whatsapp_optout", { p_phone: dest });
            await recordResult(row.outbox_id, "failed", { error: err, terminal: true });
            refused++;
            break;
          case "terminal":
            // The recipient is the problem (unreachable / not a mobile) — no config fix helps.
            await recordResult(row.outbox_id, "failed", { error: err, terminal: true });
            refused++;
            break;
          default:
            await recordResult(row.outbox_id, "failed", { error: err, terminal: false });
            failed++;
        }
      }
    }

    if (failed > 0) {
      await notifySlackEdgeError(JOB, `${failed} WhatsApp notification(s) failed to send`, {
        failed, sent, refused, deferred,
      });
    }
    // Deferred rows are NOT failures, but a config gap that never gets fixed would park rows
    // forever in silence — so it is surfaced as its own signal.
    if (deferred > 0) {
      await notifySlackEdgeError(JOB, `${deferred} WhatsApp notification(s) deferred on a config gap`, {
        deferred, sent, failed, refused,
      });
    }

    return json({ processed: rows.length, sent, failed, refused, deferred });
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
