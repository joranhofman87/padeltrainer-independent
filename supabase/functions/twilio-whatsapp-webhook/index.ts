// Notification Foundation v2 — PR 9: the Twilio WhatsApp webhook.
//
// Handles BOTH Twilio POST shapes on one signed endpoint:
//   * message STATUS callbacks (MessageStatus + MessageSid) → the delivery log, AND consent
//     withdrawal when ErrorCode is 21610 (Twilio rejected the send because the recipient had
//     already opted out — often via a STOP sent before this webhook existed)
//   * INBOUND messages (From + Body)                        → STOP handling (consent withdrawal)
//
// Both shapes can carry a withdrawal but they DISAGREE on which field holds the user's number,
// so that decision lives in optOutNumberFromPayload() rather than being re-derived here.
//
// verify_jwt = false — Twilio has no Supabase JWT — so THE SIGNATURE IS THE AUTHENTICATION and
// this endpoint is otherwise reachable by anyone. Every path fails closed:
//   * no TWILIO_AUTH_TOKEN configured  → 500, nothing processed (never "skip verification")
//   * missing/invalid X-Twilio-Signature → 403, body ignored entirely
//   * unknown status                    → recorded as ignored, never coerced into a success
//
// A forged request here could otherwise fabricate delivery history or, worse via STOP, opt a
// number out — or, if verification were skipped, let an attacker learn which SIDs we hold.
// Hence 403 before ANY parsing of the payload's meaning.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyTwilioSignature, optOutNumberFromPayload } from "../_shared/twilio-signature.ts";
import { notifySlackEdgeError } from "../_shared/edge-slack.ts";

const JOB = "twilio-whatsapp-webhook";

// No CORS: Twilio is a server-to-server caller, and this endpoint has no browser client.
const jsonHeaders = { "Content-Type": "application/json" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: jsonHeaders });

const handler = async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  try {
    const authToken = Deno.env.get("TWILIO_AUTH_TOKEN");
    if (!authToken) {
      // Refuse rather than process unverified traffic.
      await notifySlackEdgeError(JOB, "TWILIO_AUTH_TOKEN not configured — webhook rejecting all traffic");
      return json({ error: "not configured" }, 500);
    }

    // Twilio signs the exact URL it was configured to call. A proxy/rewrite would change it,
    // so it is explicit configuration (falling back to the request URL for local runs).
    const url = Deno.env.get("TWILIO_STATUS_CALLBACK_URL") || req.url;

    const raw = await req.text();
    const params: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(raw)) params[k] = v;

    const verified = await verifyTwilioSignature({
      authToken,
      url,
      params,
      signature: req.headers.get("X-Twilio-Signature"),
    });
    if (!verified) return json({ error: "invalid signature" }, 403);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ---- inbound message: consent withdrawal ----
    // Checked FIRST: a STOP must be honoured even if the same payload also carries status
    // fields. Twilio also auto-blocks the sender on STOP, but our own consent state has to
    // agree — otherwise the resolver keeps queueing messages that will never deliver.
    const optOutNumber = optOutNumberFromPayload(params);

    // An INBOUND STOP carries no status fields, so it is the whole payload: revoke and return.
    const isStatusCallback = Boolean(params.MessageStatus || params.SmsStatus);
    if (optOutNumber && !isStatusCallback) {
      const { data, error } = await supabase.rpc("record_whatsapp_optout", { p_phone: optOutNumber });
      if (error) throw new Error(`opt-out failed: ${error.message}`);
      return json({ ok: true, action: "opted_out", revoked: data ?? 0 });
    }

    // ---- status callback ----
    const messageSid = params.MessageSid ?? params.SmsSid ?? "";
    const status = params.MessageStatus ?? params.SmsStatus ?? "";
    if (messageSid && status) {
      const { data, error } = await supabase.rpc("record_whatsapp_status_event", {
        p_message_sid: messageSid,
        p_status: status,
        p_error_code: params.ErrorCode ?? null,
        p_error_message: params.ErrorMessage ?? null,
      });
      if (error) throw new Error(`status record failed: ${error.message}`);

      // A 21610 status callback is BOTH a delivery outcome and a consent event. Recording only
      // the outcome would leave the resolver queueing messages to someone who has opted out —
      // and this is the only notice we get when the STOP predates the webhook. Both writes are
      // idempotent, so a Twilio callback retry re-runs them harmlessly.
      if (optOutNumber) {
        const { data: revoked, error: optErr } = await supabase.rpc("record_whatsapp_optout", {
          p_phone: optOutNumber,
        });
        if (optErr) throw new Error(`opt-out failed: ${optErr.message}`);
        return json({ ok: true, action: "status_opted_out", result: data, revoked: revoked ?? 0 });
      }
      return json({ ok: true, action: "status", result: data });
    }

    // A verified-but-unrecognized payload is not an error: Twilio sends shapes we do not
    // subscribe to. 200 so Twilio stops retrying, but explicitly labelled as ignored.
    return json({ ok: true, action: "ignored" });
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
