import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "https://esm.sh/resend@2.0.0";
import { notifySlackEdgeError } from "../_shared/edge-slack.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[SEND-INVOICE-EMAIL] ${step}`, details ? JSON.stringify(details) : "");
};

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (!resendApiKey) {
      return new Response(
        JSON.stringify({ success: false, error: "email_not_configured" }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Authentication required" }),
        { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const token = authHeader.replace("Bearer ", "");
    const isServiceRole = token === supabaseServiceKey;

    let authenticatedUserId: string | null = null;
    let authenticatedUserEmail: string | null = null;
    if (!isServiceRole) {
      const { data: { user }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !user) {
        return new Response(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
      authenticatedUserId = user.id;
      authenticatedUserEmail = user.email ?? null;
    }

    const body = await req.json();
    const { invoiceId } = body;
    const customMessageRaw = typeof body.customMessage === "string" ? body.customMessage : "";
    const customMessage = customMessageRaw.slice(0, 2000);
    // Language is now resolved server-side from the recipient/organization.
    // The caller may pass `language` only as an explicit override for previews/test sends.
    const languageOverride = typeof body.language === "string"
      ? body.language.toLowerCase().slice(0, 2)
      : null;
    const testEmail = typeof body.testEmail === "string" && body.testEmail.trim() ? body.testEmail.trim() : null;
    const previewOnly = body.previewOnly === true;
    // Bypass for the duplicate-send guard below (deliberate immediate resends).
    const force = body.force === true;

    // Security: a test send may only be delivered to the caller's own auth email.
    // Prevents using this endpoint to phish from our domain.
    if (testEmail && !isServiceRole) {
      const normalizedTest = testEmail.toLowerCase();
      const normalizedCaller = (authenticatedUserEmail || "").toLowerCase();
      if (!normalizedCaller || normalizedTest !== normalizedCaller) {
        return new Response(
          JSON.stringify({ success: false, error: "test_email_must_match_caller" }),
          { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
    }
    if (!invoiceId) {
      return new Response(
        JSON.stringify({ error: "Missing invoiceId" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    logStep("started", {
      invoiceId,
      previewOnly,
      testSend: !!testEmail,
    });

    // Fetch invoice with guest player info
    const { data: invoice, error: invoiceError } = await supabase
      .from("invoices")
      .select("*, guest_players(email, full_name)")
      .eq("id", invoiceId)
      .single();

    if (invoiceError || !invoice) {
      return new Response(
        JSON.stringify({ error: "Invoice not found" }),
        { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Resolve recipient email
    let recipientEmail: string | null = null;

    // Try guest player email first
    if (invoice.guest_players?.email) {
      recipientEmail = invoice.guest_players.email;
    }

    // Try registered player profile email
    if (!recipientEmail && invoice.player_id) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("email")
        .eq("user_id", invoice.player_id)
        .single();
      if (profile?.email) {
        recipientEmail = profile.email;
      }
    }

    // For test sends and previews we don't require a recipient email on the invoice
    if (!recipientEmail && !testEmail && !previewOnly) {
      logStep("no_recipient", { invoiceId, invoiceNumber: invoice.invoice_number });
      return new Response(
        JSON.stringify({ success: false, error: "no_email", playerName: invoice.player_name }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Fetch academy/trainer profile for branding + reply-to + invoice language
    let businessName = "PadelTrainer.ai";
    let slug = "";
    let replyTo: string | null = null;
    let orgLanguage: string | null = null;

    if (invoice.academy_profile_id) {
      const { data: academy } = await supabase
        .from("academy_profiles")
        .select("name, slug, business_name, contact_email, invoice_forward_emails, invoice_reply_to_email, invoice_language")
        .eq("id", invoice.academy_profile_id)
        .single();
      if (academy) {
        businessName = academy.business_name || academy.name || businessName;
        slug = academy.slug || "";
        orgLanguage = (academy as any).invoice_language || null;
        replyTo = (academy as any).invoice_reply_to_email
          || academy.contact_email
          || (Array.isArray(academy.invoice_forward_emails) && academy.invoice_forward_emails[0])
          || null;
      }
    } else if (invoice.trainer_id) {
      const { data: trainer } = await supabase
        .from("trainer_profiles")
        .select("user_id, business_name, invoice_forward_emails, invoice_reply_to_email, invoice_language")
        .eq("id", invoice.trainer_id)
        .single();
      if (trainer) {
        businessName = trainer.business_name || businessName;
        orgLanguage = (trainer as any).invoice_language || null;
        replyTo = (trainer as any).invoice_reply_to_email
          || (Array.isArray(trainer.invoice_forward_emails) && trainer.invoice_forward_emails[0])
          || null;
        if (!replyTo && trainer.user_id) {
          const { data: trainerProfileEmail } = await supabase
            .from("profiles")
            .select("email")
            .eq("user_id", trainer.user_id)
            .single();
          if (trainerProfileEmail?.email) replyTo = trainerProfileEmail.email;
        }
      }
    }

    // Resolve recipient language: registered player preference > org default > 'nl'
    let recipientLanguage: string | null = null;
    if (invoice.player_id) {
      let { data: playerProfile } = await supabase
        .from("profiles")
        .select("preferred_language")
        .eq("id", invoice.player_id)
        .maybeSingle();
      if (!playerProfile) {
        const { data: byUserId } = await supabase
          .from("profiles")
          .select("preferred_language")
          .eq("user_id", invoice.player_id)
          .maybeSingle();
        playerProfile = byUserId;
      }
      if (playerProfile?.preferred_language) {
        recipientLanguage = String(playerProfile.preferred_language).toLowerCase().slice(0, 2);
      }
    }

    // For preview/test sends, allow caller override so managers can preview any language.
    const isPreviewOrTest = previewOnly || !!testEmail;
    const language = (isPreviewOrTest && languageOverride)
      ? languageOverride
      : (recipientLanguage || orgLanguage || "nl");

    // Also verify ownership if not service role
    if (!isServiceRole && invoice.trainer_id) {
      const { data: trainerProfile } = await supabase
        .from("trainer_profiles")
        .select("user_id")
        .eq("id", invoice.trainer_id)
        .single();
      
      if (invoice.academy_profile_id) {
        // Check academy manager access
        const { data: isManager } = await supabase
          .rpc("is_academy_manager", { _user_id: authenticatedUserId, _academy_profile_id: invoice.academy_profile_id });
        if (!isManager && trainerProfile?.user_id !== authenticatedUserId) {
          return new Response(
            JSON.stringify({ error: "Unauthorized" }),
            { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }
      } else if (trainerProfile?.user_id !== authenticatedUserId) {
        return new Response(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
    } else if (!isServiceRole && invoice.academy_profile_id) {
      // Custom invoice without trainer - check academy manager access
      const { data: isManager } = await supabase
        .rpc("is_academy_manager", { _user_id: authenticatedUserId, _academy_profile_id: invoice.academy_profile_id });
      if (!isManager) {
        return new Response(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
    }

    // Duplicate-send guard: rapid double-clicks/retries on an invoice that was
    // just delivered are no-ops unless the caller explicitly passes force=true.
    // Deliberate resends (after the window) keep working unchanged.
    const RECENT_SEND_WINDOW_MS = 2 * 60 * 1000;
    if (!previewOnly && !testEmail && !force && invoice.sent_at) {
      const sentAtMs = Date.parse(invoice.sent_at);
      if (Number.isFinite(sentAtMs) && Date.now() - sentAtMs < RECENT_SEND_WINDOW_MS) {
        logStep("skipped_recently_sent", { invoiceId, invoiceNumber: invoice.invoice_number });
        return new Response(
          JSON.stringify({ success: true, skipped: "recently_sent", email: recipientEmail }),
          { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
    }

    // Build public invoice URL using recipient language
    const supportedLangs = ["nl", "en", "es", "de", "fr", "it"];
    const urlLang = supportedLangs.includes(language) ? language : "nl";
    const publicUrl = invoice.public_token && slug
      ? `https://padeltrainer.ai/${urlLang}/academies/${slug}/pay/${invoice.public_token}`
      : null;

    const localeMap: Record<string, string> = {
      nl: "nl-NL", en: "en-GB", es: "es-ES", de: "de-DE", fr: "fr-FR", it: "it-IT",
    };
    const numLocale = localeMap[language] || "nl-NL";
    const formatCurrency = (amount: number) =>
      new Intl.NumberFormat(numLocale, { style: "currency", currency: "EUR" }).format(amount);

    const formatDate = (dateStr: string) => {
      const d = new Date(dateStr);
      return d.toLocaleDateString(numLocale, { day: "numeric", month: "long", year: "numeric" });
    };

    const T: Record<string, Record<string, string>> = {
      nl: { hi: "Hallo", invoice: "Factuur", from: "Van", number: "Factuurnummer", date: "Factuurdatum", due: "Vervaldatum", amount: "Bedrag", vat: "BTW", cta: "Bekijk & Betaal Factuur", orCopy: "Of kopieer deze link", sentVia: "Verzonden via PadelTrainer.ai namens", subject: "Factuur", nameFallback: "daar" },
      en: { hi: "Hi", invoice: "Invoice", from: "From", number: "Invoice number", date: "Invoice date", due: "Due date", amount: "Amount", vat: "VAT", cta: "View & Pay Invoice", orCopy: "Or copy this link", sentVia: "Sent via PadelTrainer.ai on behalf of", subject: "Invoice", nameFallback: "there" },
      es: { hi: "Hola", invoice: "Factura", from: "De", number: "Número de factura", date: "Fecha de factura", due: "Fecha de vencimiento", amount: "Importe", vat: "IVA", cta: "Ver y Pagar Factura", orCopy: "O copia este enlace", sentVia: "Enviado vía PadelTrainer.ai en nombre de", subject: "Factura", nameFallback: "hola" },
      de: { hi: "Hallo", invoice: "Rechnung", from: "Von", number: "Rechnungsnummer", date: "Rechnungsdatum", due: "Fälligkeitsdatum", amount: "Betrag", vat: "MwSt.", cta: "Rechnung Ansehen & Bezahlen", orCopy: "Oder diesen Link kopieren", sentVia: "Gesendet über PadelTrainer.ai im Auftrag von", subject: "Rechnung", nameFallback: "zusammen" },
      fr: { hi: "Bonjour", invoice: "Facture", from: "De", number: "Numéro de facture", date: "Date de facture", due: "Date d'échéance", amount: "Montant", vat: "TVA", cta: "Voir et Payer la Facture", orCopy: "Ou copiez ce lien", sentVia: "Envoyé via PadelTrainer.ai pour le compte de", subject: "Facture", nameFallback: "à toi" },
      it: { hi: "Ciao", invoice: "Fattura", from: "Da", number: "Numero fattura", date: "Data fattura", due: "Data di scadenza", amount: "Importo", vat: "IVA", cta: "Visualizza e Paga Fattura", orCopy: "Oppure copia questo link", sentVia: "Inviato tramite PadelTrainer.ai per conto di", subject: "Fattura", nameFallback: "ciao" },
    };
    const tr = T[language] || T.nl;

    const fullName = (invoice.player_name || "").trim();
    const nameParts = fullName.split(/\s+/).filter(Boolean);
    const firstName = nameParts[0] || "";
    const lastName = nameParts.slice(1).join(" ");

    // Token substitution. Supports `{first_name}` and explicit fallback `{first_name|there}`.
    // When a token has no value AND no inline fallback, use the language-aware default (tr.nameFallback).
    const resolveToken = (value: string, inlineFallback: string | undefined) => {
      if (value && value.trim()) return value;
      if (inlineFallback && inlineFallback.trim()) return inlineFallback.trim();
      return tr.nameFallback;
    };
    const substituteVars = (s: string) => s
      .replace(/\{\s*first[_\s]?name(?:\s*\|\s*([^}]*))?\s*\}/gi, (_m, fb) => resolveToken(firstName, fb))
      .replace(/\{\s*last[_\s]?name(?:\s*\|\s*([^}]*))?\s*\}/gi, (_m, fb) => resolveToken(lastName, fb))
      .replace(/\{\s*full[_\s]?name(?:\s*\|\s*([^}]*))?\s*\}/gi, (_m, fb) => resolveToken(fullName, fb));

    const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
    const personalizedMessage = substituteVars(customMessage);
    const customHtml = personalizedMessage.trim()
      ? `<div style="margin: 0 0 24px; color:#374151; font-size:14px; line-height:1.6; white-space:pre-wrap;">${escapeHtml(personalizedMessage)}</div>`
      : "";

    const subject = `${tr.subject} ${invoice.invoice_number} - ${businessName}`;
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          ${customHtml}
          ${customHtml ? `<hr style="border: none; border-top: 1px solid #e5e7eb; margin: 0 0 32px;" />` : ""}
          <h2 style="color: #1a1a1a; margin-bottom: 8px;">${tr.invoice} ${invoice.invoice_number}</h2>
          <p style="color: #6b7280; margin-bottom: 24px;">${tr.from} ${escapeHtml(businessName)}</p>

          <table style="border-collapse: collapse; width: 100%; margin-bottom: 24px;">
            <tr>
              <td style="padding: 8px 12px 8px 0; color: #6b7280; border-bottom: 1px solid #e5e7eb;">${tr.number}</td>
              <td style="padding: 8px 0; border-bottom: 1px solid #e5e7eb; font-weight: 500;">${invoice.invoice_number}</td>
            </tr>
            <tr>
              <td style="padding: 8px 12px 8px 0; color: #6b7280; border-bottom: 1px solid #e5e7eb;">${tr.date}</td>
              <td style="padding: 8px 0; border-bottom: 1px solid #e5e7eb;">${formatDate(invoice.invoice_date)}</td>
            </tr>
            <tr>
              <td style="padding: 8px 12px 8px 0; color: #6b7280; border-bottom: 1px solid #e5e7eb;">${tr.due}</td>
              <td style="padding: 8px 0; border-bottom: 1px solid #e5e7eb;">${formatDate(invoice.due_date)}</td>
            </tr>
            <tr>
              <td style="padding: 8px 12px 8px 0; color: #6b7280; border-bottom: 1px solid #e5e7eb;">${tr.amount}</td>
              <td style="padding: 8px 0; border-bottom: 1px solid #e5e7eb; font-weight: 700; font-size: 18px;">${formatCurrency(invoice.total)}</td>
            </tr>
            <tr>
              <td style="padding: 8px 12px 8px 0; color: #6b7280;">${tr.vat}</td>
              <td style="padding: 8px 0;">${formatCurrency(invoice.vat_amount)} (${invoice.vat_rate}%)</td>
            </tr>
          </table>

          ${publicUrl ? `
            <div style="text-align: center; margin: 32px 0;">
              <a href="${publicUrl}" style="display: inline-block; background: #f45d25; color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px;">
                ${tr.cta}
              </a>
            </div>
            <p style="text-align: center; color: #9ca3af; font-size: 13px; margin-top: 8px;">
              ${tr.orCopy}: <a href="${publicUrl}" style="color: #f45d25;">${publicUrl}</a>
            </p>
          ` : ""}

          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;" />
          <p style="font-size: 12px; color: #9ca3af; text-align: center;">
            ${tr.sentVia} ${escapeHtml(businessName)}
          </p>
        </div>
      `;

    if (previewOnly) {
      return new Response(
        JSON.stringify({ success: true, html, subject, recipientEmail }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    const resend = new Resend(resendApiKey);
    const sendTo = testEmail || recipientEmail;
    if (!sendTo) {
      return new Response(
        JSON.stringify({ success: false, error: "no_email" }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }
    const { error: sendError } = await resend.emails.send({
      from: "PadelTrainer.ai <noreply@app.padeltrainer.ai>",
      to: [sendTo],
      subject: testEmail ? `[TEST] ${subject}` : subject,
      html,
      reply_to: replyTo || undefined,
    });

    if (sendError) {
      logStep("failed", {
        invoiceId,
        invoiceNumber: invoice.invoice_number,
        errorCode: "send_failed",
      });
      await notifySlackEdgeError(
        "send-invoice-email",
        "Resend send failed",
        { invoiceId, invoiceNumber: invoice.invoice_number, error: String(sendError) },
      );
      return new Response(
        JSON.stringify({ success: false, error: "send_failed", details: sendError }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Stamp sent_at and promote draft -> sent only after a real successful delivery
    if (!testEmail) {
      try {
        const updates: Record<string, unknown> = {};
        if (!invoice.sent_at) updates.sent_at = new Date().toISOString();
        if (invoice.status === "draft") updates.status = "sent";
        if (Object.keys(updates).length > 0) {
          const { error: statusUpdateError } = await supabase
            .from("invoices")
            .update(updates)
            .eq("id", invoice.id);
          if (statusUpdateError) {
            logStep("status_update_failed", {
              invoiceId,
              invoiceNumber: invoice.invoice_number,
              error: statusUpdateError.message,
            });
            await notifySlackEdgeError(
              "send-invoice-email",
              "Invoice sent_at/status update failed after email delivery",
              {
                invoiceId,
                invoiceNumber: invoice.invoice_number,
                error: statusUpdateError.message,
              },
            );
          }
        }
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        logStep("status_update_failed", {
          invoiceId,
          invoiceNumber: invoice.invoice_number,
          error: errMsg,
        });
        await notifySlackEdgeError(
          "send-invoice-email",
          "Invoice sent_at/status update failed after email delivery",
          { invoiceId, invoiceNumber: invoice.invoice_number, error: errMsg },
        );
      }
    }

    logStep("sent", {
      invoiceId,
      invoiceNumber: invoice.invoice_number,
      testSend: !!testEmail,
    });

    return new Response(
      JSON.stringify({ success: true, email: recipientEmail }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  } catch (error: any) {
    const message = error?.message ?? String(error);
    logStep("failed", { error: message });
    await notifySlackEdgeError("send-invoice-email", message);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
};

serve(handler);
