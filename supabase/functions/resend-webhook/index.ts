// Resend delivery-event webhook. Verifies the Svix signature and does TWO things with every
// callback it recognises: records it for deliverability (record_email_event, idempotent on the
// svix id) and, for the seven callbacks ADR 0008 §PV gives a transition, drives the digest state
// machine (apply_notification_provider_event, idempotent on the same id).
//
// 10c-b E added the second half. Before it, a digest send's callbacks reached nothing: the group
// sat in `sending`/`awaiting_evidence` until the stale sweep aged it out, and the orphan queue
// that exists to correlate an early callback had no producer at all. `email.suppressed` and
// `suppression.removed` were also unmapped, so a Resend suppression was acknowledged and thrown
// away even though the database has understood both since 20261006100000.
//
// Every rule lives in _shared/resend-webhook-events.ts — this module ends in `serve(...)` and can
// never be imported, so a test here would only ever be a copy.
//
// verify_jwt = false (config.toml): Resend can't send a Supabase JWT; auth is the
// Svix signature instead. Returns 5xx on transient failure so Resend retries.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { verifySvix } from "../_shared/svix-verify.ts";
import { notifySlackEdgeError } from "../_shared/edge-slack.ts";
import { handleResendCallback, parseResendEvent } from "../_shared/resend-webhook-events.ts";

const logStep = (step: string, details?: Record<string, unknown>) =>
  console.log(`[RESEND-WEBHOOK] ${step}`, details ? JSON.stringify(details) : "");

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  try {

  const secret = Deno.env.get("RESEND_WEBHOOK_SECRET");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!secret || !supabaseUrl || !serviceKey) {
    logStep("misconfigured");
    return new Response("misconfigured", { status: 500 });
  }

  const body = await req.text();
  const svixId = req.headers.get("svix-id");
  const verified = await verifySvix({
    secret,
    id: svixId,
    timestamp: req.headers.get("svix-timestamp"),
    signature: req.headers.get("svix-signature"),
    body,
  });
  if (!verified) {
    logStep("invalid_signature");
    return new Response("invalid signature", { status: 401 });
  }

  let evt: unknown;
  try {
    evt = JSON.parse(body);
  } catch (err) {
    // Was fully silent: at minimum surface the parse failure (svix already verified
    // this body, so malformed JSON here is unexpected). 400 -> Resend won't retry.
    logStep("bad_json", { error: err instanceof Error ? err.message : String(err) });
    return new Response("bad json", { status: 400 });
  }

  const parsed = parseResendEvent(evt);
  // engagement events (opened/clicked) or unmapped types: acknowledge + ignore
  if (!parsed) {
    return new Response(JSON.stringify({ ignored: (evt as { type?: string } | null)?.type ?? null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  const { eventType, recipient, resendEmailId, occurredAt, bounceType, reason } = parsed;
  const supabase = createClient(supabaseUrl, serviceKey);

  // Best-effort: map the event back to its invoice via the original 'sent' row so
  // per-invoice queries are trivial (the address-state rollup is keyed on email).
  let invoiceId: string | null = null;
  let academyId: string | null = null;
  let trainerId: string | null = null;
  if (resendEmailId) {
    const { data: origin } = await supabase
      .from("email_delivery_events")
      .select("invoice_id, academy_profile_id, trainer_id")
      .eq("resend_email_id", resendEmailId)
      .not("invoice_id", "is", null)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (origin) {
      invoiceId = origin.invoice_id;
      academyId = origin.academy_profile_id;
      trainerId = origin.trainer_id;
    }
  }

  // The ORDER — record first, then apply, and what each failure answers — is production logic
  // with its own tests in _shared/resend-webhook-events.ts. Keeping it inline here would put the
  // load-bearing part of this route in the one file the suite can never import.
  const result = await handleResendCallback(parsed, {
    recordEvent: async () => {
      const { error } = await supabase.rpc("record_email_event", {
        p_event_type: eventType,
        p_recipient_email: recipient,
        p_resend_email_id: resendEmailId,
        p_resend_event_id: svixId,
        p_bounce_type: bounceType,
        p_reason: reason,
        p_invoice_id: invoiceId,
        p_academy_profile_id: academyId,
        p_trainer_id: trainerId,
        p_occurred_at: occurredAt,
      });
      if (error) throw new Error(error.message);
    },
    applyDigest: async () => {
      // A missing tag is NOT an error: the SQL falls back to correlating by provider_message_id
      // and answers `not_digest` for the invoice/reminder mail that is most of this traffic.
      const { data, error } = await supabase.rpc("apply_notification_provider_event", {
        p_run_id: null,                     // a webhook is not a worker run
        p_resend_event_id: svixId,
        p_provider_message_id: resendEmailId,
        p_digest_group_id: parsed.digestGroupId,
        p_status: eventType,
        p_occurred_at: occurredAt,
        p_now: null,
      });
      if (error) throw new Error(error.message);
      return typeof data === "string" ? data : null;
    },
    // IDs only, never PII. notifySlackEdgeError never throws.
    alert: (message) => notifySlackEdgeError("resend-webhook", message, { eventType, resendEmailId }),
  });

  logStep(result.step, { eventType, resendEmailId, digestOutcome: result.digestOutcome });
  if (result.status !== 200) {
    return new Response("callback not applied", { status: result.status }); // 5xx → Resend retries
  }
  return new Response(JSON.stringify({ ok: true, digest: result.digestOutcome }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  } catch (error) {
    // Silent-blackout guard: any unexpected throw in the ingestion path (verify,
    // origin lookup, record_email_event) would otherwise vanish into a bare 500.
    const msg = error instanceof Error ? error.message : String(error);
    logStep("unhandled_error", { error: msg });
    await notifySlackEdgeError("resend-webhook", msg);
    return new Response("internal error", { status: 500 }); // 5xx -> Resend retries
  }
});
