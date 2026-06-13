import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { Resend } from "https://esm.sh/resend@2.0.0";
import {
  resolveForwardRecipients,
  type ForwardEmailSource,
} from "../_shared/forward-invoice-emails.ts";
import { authenticateForwardInvoice } from "../_shared/forward-invoice-auth.ts";
import {
  countSendOutcomes,
  evaluateForwardSendCompletion,
  parseResendSendResult,
  type ForwardInvoiceResponse,
} from "../_shared/forward-invoice-response.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[FORWARD-INVOICE] ${step}`, details ? JSON.stringify(details) : "");
};

function jsonResponse(body: ForwardInvoiceResponse | Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  logStep("request_received", {
    method: req.method,
    hasAuthorizationHeader: !!req.headers.get("Authorization"),
    hasApiKeyHeader: !!req.headers.get("apikey"),
  });

  try {
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (!resendApiKey) {
      return jsonResponse({ success: false, reason: "email_not_configured", sent: 0, failed: 0 }, 500);
    }

    const resend = new Resend(resendApiKey);

    const EMAIL_LOGO =
      `<div style="text-align: center; margin-bottom: 24px;"><img src="https://padeltrainer.ai/logo-dark.png" alt="PadelTrainer.ai" width="220" height="40" style="max-width: 220px; height: auto;" /></div>`;

    const formatCurrency = (amount: number) =>
      new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(amount);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const auth = await authenticateForwardInvoice(req);
    if (!auth.ok) {
      logStep("auth_denied", { status: auth.status, authMode: auth.authMode });
      return auth.response;
    }

    const { supabase, isServiceRole, user } = auth.auth;
    const authenticatedUserId = isServiceRole ? null : user.id;

    logStep("auth_resolved", { authMode: auth.authMode });

    const body = await req.json();
    const invoiceId = typeof body?.invoiceId === "string" ? body.invoiceId : "";
    const force = body?.force === true;

    if (!invoiceId) {
      logStep("validation_failed", { reason: "missing_invoice_id", authMode: auth.authMode });
      return jsonResponse({ error: "Missing invoiceId" }, 400);
    }

    logStep("started", { invoiceId, force, authMode: auth.authMode });

    const { data: invoice, error: invoiceError } = await supabase
      .from("invoices")
      .select("*")
      .eq("id", invoiceId)
      .single();

    if (invoiceError || !invoice) {
      return jsonResponse({ error: "Invoice not found" }, 404);
    }

    if (invoice.forwarded_at && !force) {
      logStep("skipped", { invoiceId, invoiceNumber: invoice.invoice_number, reason: "already_forwarded" });
      return jsonResponse({
        success: true,
        skipped: true,
        reason: "already_forwarded",
        sent: 0,
        failed: 0,
        invoice_number: invoice.invoice_number,
      });
    }

    let trainerProfile: { user_id: string; invoice_forward_emails: string[] | null; business_name: string | null } | null = null;
    if (invoice.trainer_id) {
      const { data } = await supabase
        .from("trainer_profiles")
        .select("user_id, invoice_forward_emails, business_name")
        .eq("id", invoice.trainer_id)
        .maybeSingle();
      trainerProfile = data;
    }

    let academyProfile: { invoice_forward_emails: string[] | null; business_name: string | null } | null = null;
    if (invoice.academy_profile_id) {
      const { data } = await supabase
        .from("academy_profiles")
        .select("invoice_forward_emails, business_name")
        .eq("id", invoice.academy_profile_id)
        .maybeSingle();
      academyProfile = data;
    }

    if (!isServiceRole) {
      let authorized = trainerProfile?.user_id === authenticatedUserId;

      if (!authorized && invoice.academy_profile_id) {
        const { data: isManager } = await supabase
          .rpc("is_academy_manager", {
            _user_id: authenticatedUserId,
            _academy_profile_id: invoice.academy_profile_id,
          });
        authorized = !!isManager;
      }

      if (!authorized) {
        return jsonResponse({ error: "Unauthorized" }, 403);
      }
    }

    const { emails, source: emailSource } = resolveForwardRecipients({
      academyProfileId: invoice.academy_profile_id,
      academyForwardEmails: academyProfile?.invoice_forward_emails,
      trainerForwardEmails: trainerProfile?.invoice_forward_emails,
    });

    const businessName = invoice.academy_profile_id
      ? (academyProfile?.business_name || trainerProfile?.business_name || invoice.player_name)
      : (trainerProfile?.business_name || invoice.player_name);

    logStep("recipients_resolved", {
      invoiceId,
      invoiceNumber: invoice.invoice_number,
      emailSource,
      recipientCount: emails.length,
    });

    if (emails.length === 0) {
      logStep("no_recipients", { invoiceId, invoiceNumber: invoice.invoice_number, emailSource: "none" });
      return jsonResponse({
        success: false,
        sent: 0,
        failed: 0,
        reason: "no_recipients",
        pdf_attached: false,
        email_source: "none" as ForwardEmailSource,
        invoice_number: invoice.invoice_number,
      });
    }

    const folderKey = trainerProfile?.user_id || invoice.academy_profile_id || "custom";
    const pdfFileName = `${folderKey}/${invoice.invoice_number}.pdf`;

    let pdfData: Blob | null = null;
    const downloadResult = await supabase.storage.from("invoices").download(pdfFileName);
    pdfData = downloadResult.data;

    if (!pdfData) {
      logStep("pdf_missing_generating", { invoiceId, pdfFileName });
      try {
        const genResponse = await fetch(`${supabaseUrl}/functions/v1/generate-invoice`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${supabaseServiceKey}`,
          },
          body: JSON.stringify({ invoiceId }),
        });
        if (genResponse.ok) {
          const retryResult = await supabase.storage.from("invoices").download(pdfFileName);
          pdfData = retryResult.data;
        } else {
          const errText = await genResponse.text();
          logStep("pdf_generate_failed", { invoiceId, status: genResponse.status, error: errText.slice(0, 200) });
        }
      } catch (genErr) {
        logStep("pdf_generate_error", { invoiceId, error: String(genErr) });
      }
    }

    if (!pdfData) {
      logStep("pdf_unavailable", { invoiceId, invoiceNumber: invoice.invoice_number });
      return jsonResponse({
        success: false,
        sent: 0,
        failed: 0,
        reason: "pdf_missing",
        pdf_attached: false,
        email_source: emailSource,
        invoice_number: invoice.invoice_number,
      });
    }

    const buffer = await pdfData.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);
    const attachments = [{ filename: `${invoice.invoice_number}.pdf`, content: base64 }];

    logStep("pdf_attached", { invoiceId, invoiceNumber: invoice.invoice_number, bytes: bytes.length });

    const { data: signedUrl } = await supabase.storage
      .from("invoices")
      .createSignedUrl(pdfFileName, 86400);
    const pdfLink = signedUrl?.signedUrl || invoice.pdf_url || "";

    let playerReplyTo: string | null = null;
    // Single source of truth: resolves a linked guest's email from the parent
    // profile first (FAM-02), so an edited contact is honoured.
    const { data: replyIdRows } = await supabase.rpc("get_invoice_recipient_identity", {
      _player_id: invoice.player_id ?? null,
      _guest_player_id: invoice.guest_player_id ?? null,
    });
    const replyIdentity = Array.isArray(replyIdRows) ? replyIdRows[0] : replyIdRows;
    if (replyIdentity?.email) playerReplyTo = replyIdentity.email;
    // Historic fallback: some old rows stored a user_id in player_id (the RPC
    // keys on profiles.id).
    if (!playerReplyTo && invoice.player_id) {
      const { data: byUserId } = await supabase
        .from("profiles")
        .select("email")
        .eq("user_id", invoice.player_id)
        .maybeSingle();
      if (byUserId?.email) playerReplyTo = byUserId.email;
    }

    const sendOutcomes: Array<{ ok: boolean; email: string; error?: string; resendId?: string }> = [];
    for (const email of emails) {
      const { data: resendData, error: resendError } = await resend.emails.send({
        from: "PadelTrainer.ai <noreply@app.padeltrainer.ai>",
        to: [email],
        subject: `Factuur ${invoice.invoice_number} - ${businessName || invoice.player_name}`,
        reply_to: playerReplyTo || undefined,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          ${EMAIL_LOGO}
          <h2>Factuur ${invoice.invoice_number}</h2>
          <table style="border-collapse:collapse;font-family:Arial,sans-serif;">
            <tr><td style="padding:4px 12px 4px 0;color:#6b7280;">Klant:</td><td>${invoice.player_name}</td></tr>
            <tr><td style="padding:4px 12px 4px 0;color:#6b7280;">Datum:</td><td>${invoice.invoice_date}</td></tr>
            <tr><td style="padding:4px 12px 4px 0;color:#6b7280;">Bedrag:</td><td><strong>${formatCurrency(invoice.total)}</strong> (incl. ${invoice.vat_rate}% BTW)</td></tr>
            <tr><td style="padding:4px 12px 4px 0;color:#6b7280;">Status:</td><td>${invoice.status === "paid" ? "✅ Betaald" : invoice.status}</td></tr>
          </table>
          ${pdfLink ? `<p style="margin-top:20px;"><a href="${pdfLink}" style="background:#f45d25;color:white;padding:10px 20px;border-radius:6px;text-decoration:none;">Download Factuur</a></p>` : ""}
          <p style="margin-top:24px;font-size:12px;color:#9ca3af;">Verzonden via PadelTrainer.ai namens ${businessName || "je trainer"}</p>
          </div>
        `,
        attachments,
      });

      const parsed = parseResendSendResult(resendData, resendError);
      sendOutcomes.push({
        ok: parsed.ok,
        email,
        error: parsed.error,
        resendId: parsed.resendId,
      });
    }

    const { sent, failed } = countSendOutcomes(sendOutcomes);
    const errors = sendOutcomes.filter((o) => !o.ok).map((o) => `${o.email}: ${o.error ?? "unknown"}`);
    const pdfAttached = true;
    const completion = evaluateForwardSendCompletion({
      sent,
      failed,
      totalRecipients: emails.length,
      pdfAttached,
    });

    logStep("send_complete", {
      invoiceId,
      invoiceNumber: invoice.invoice_number,
      emailSource,
      sent,
      failed,
      totalRecipients: emails.length,
      pdf_attached: pdfAttached,
      success: completion.success,
      reason: completion.reason,
    });

    if (completion.shouldSetForwardedAt) {
      await supabase
        .from("invoices")
        .update({ forwarded_at: new Date().toISOString() })
        .eq("id", invoice.id);
    }

    return jsonResponse({
      success: completion.success,
      sent,
      failed,
      pdf_attached: pdfAttached,
      email_source: emailSource,
      invoice_number: invoice.invoice_number,
      ...(completion.reason ? { reason: completion.reason } : {}),
      ...(errors.length > 0 ? { errors } : {}),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logStep("failed", { error: message });
    return jsonResponse({ success: false, reason: "internal_error", sent: 0, failed: 0, error: message }, 500);
  }
};

serve(handler);
