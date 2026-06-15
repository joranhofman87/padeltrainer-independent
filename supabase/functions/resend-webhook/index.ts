// Resend delivery-event webhook. Receives email.{sent,delivered,bounced,
// complained,delivery_delayed,failed}, verifies the Svix signature, and records
// the event via record_email_event (idempotent on the svix-id). This is how a
// bounce that happens AFTER Resend accepts a message becomes visible — without it
// the academy never learns reminders aren't landing.
//
// verify_jwt = false (config.toml): Resend can't send a Supabase JWT; auth is the
// Svix signature instead. Returns 5xx on transient failure so Resend retries.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { verifySvix } from "../_shared/svix-verify.ts";

const logStep = (step: string, details?: Record<string, unknown>) =>
  console.log(`[RESEND-WEBHOOK] ${step}`, details ? JSON.stringify(details) : "");

const EVENT_MAP: Record<string, string> = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.delivery_delayed": "delivery_delayed",
  "email.failed": "failed",
};

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

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

  let evt: Record<string, any>;
  try {
    evt = JSON.parse(body);
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const data = evt?.data ?? {};
  const eventType = EVENT_MAP[evt?.type ?? ""];
  const recipient = Array.isArray(data.to) ? data.to[0] : data.to;

  // engagement events (opened/clicked) or unmapped types: acknowledge + ignore
  if (!eventType || !recipient) {
    return new Response(JSON.stringify({ ignored: evt?.type ?? null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  let bounceType: string | null = null;
  let reason: string | null = null;
  if (eventType === "bounced") {
    const b = data.bounce ?? {};
    bounceType = b.type === "Permanent" ? "hard" : "soft"; // conservative: only clear-permanent suppresses
    reason = b.message ?? b.subType ?? b.type ?? null;
  } else if (eventType === "complained") {
    reason = "spam complaint";
  }

  const resendEmailId = data.email_id ?? null;
  const occurredAt = evt?.created_at ?? data?.created_at ?? null;
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

  if (error) {
    logStep("record_failed", { error: error.message });
    return new Response("record failed", { status: 500 }); // 5xx → Resend retries
  }

  logStep("recorded", { eventType, resendEmailId });
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
