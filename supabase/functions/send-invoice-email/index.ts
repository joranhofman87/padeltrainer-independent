import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "https://esm.sh/resend@2.0.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
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
    if (!isServiceRole) {
      const { data: { user }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !user) {
        return new Response(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
      authenticatedUserId = user.id;
    }

    const body = await req.json();
    const { invoiceId } = body;
    const customMessageRaw = typeof body.customMessage === "string" ? body.customMessage : "";
    const customMessage = customMessageRaw.slice(0, 2000);
    const language = (typeof body.language === "string" ? body.language : "nl").toLowerCase().slice(0, 2);
    if (!invoiceId) {
      return new Response(
        JSON.stringify({ error: "Missing invoiceId" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

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

    if (!recipientEmail) {
      return new Response(
        JSON.stringify({ success: false, error: "no_email", playerName: invoice.player_name }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Fetch academy profile for branding
    let businessName = "PadelTrainer.ai";
    let slug = "";

    if (invoice.academy_profile_id) {
      const { data: academy } = await supabase
        .from("academy_profiles")
        .select("name, slug, business_name")
        .eq("id", invoice.academy_profile_id)
        .single();
      if (academy) {
        businessName = academy.business_name || academy.name || businessName;
        slug = academy.slug || "";
      }
    } else if (invoice.trainer_id) {
      // Fetch trainer profile for slug/branding
      const { data: trainer } = await supabase
        .from("trainer_profiles")
        .select("user_id, business_name")
        .eq("id", invoice.trainer_id)
        .single();
      if (trainer) {
        businessName = trainer.business_name || businessName;
      }
    }

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

    // Build public invoice URL
    const publicUrl = invoice.public_token && slug
      ? `https://padeltrainer.ai/nl/academies/${slug}/pay/${invoice.public_token}`
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
      nl: { hi: "Hallo", invoice: "Factuur", from: "Van", number: "Factuurnummer", date: "Factuurdatum", due: "Vervaldatum", amount: "Bedrag", vat: "BTW", cta: "Bekijk & Betaal Factuur", orCopy: "Of kopieer deze link", sentVia: "Verzonden via PadelTrainer.ai namens", subject: "Factuur" },
      en: { hi: "Hi", invoice: "Invoice", from: "From", number: "Invoice number", date: "Invoice date", due: "Due date", amount: "Amount", vat: "VAT", cta: "View & Pay Invoice", orCopy: "Or copy this link", sentVia: "Sent via PadelTrainer.ai on behalf of", subject: "Invoice" },
      es: { hi: "Hola", invoice: "Factura", from: "De", number: "Número de factura", date: "Fecha de factura", due: "Fecha de vencimiento", amount: "Importe", vat: "IVA", cta: "Ver y Pagar Factura", orCopy: "O copia este enlace", sentVia: "Enviado vía PadelTrainer.ai en nombre de", subject: "Factura" },
      de: { hi: "Hallo", invoice: "Rechnung", from: "Von", number: "Rechnungsnummer", date: "Rechnungsdatum", due: "Fälligkeitsdatum", amount: "Betrag", vat: "MwSt.", cta: "Rechnung Ansehen & Bezahlen", orCopy: "Oder diesen Link kopieren", sentVia: "Gesendet über PadelTrainer.ai im Auftrag von", subject: "Rechnung" },
      fr: { hi: "Bonjour", invoice: "Facture", from: "De", number: "Numéro de facture", date: "Date de facture", due: "Date d'échéance", amount: "Montant", vat: "TVA", cta: "Voir et Payer la Facture", orCopy: "Ou copiez ce lien", sentVia: "Envoyé via PadelTrainer.ai pour le compte de", subject: "Facture" },
      it: { hi: "Ciao", invoice: "Fattura", from: "Da", number: "Numero fattura", date: "Data fattura", due: "Data di scadenza", amount: "Importo", vat: "IVA", cta: "Visualizza e Paga Fattura", orCopy: "Oppure copia questo link", sentVia: "Inviato tramite PadelTrainer.ai per conto di", subject: "Fattura" },
    };
    const tr = T[language] || T.nl;

    const firstName = (invoice.player_name || "").split(" ")[0] || invoice.player_name || "";
    const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
    const customHtml = customMessage.trim()
      ? `<div style="margin: 16px 0 24px; color:#374151; font-size:14px; line-height:1.6; white-space:pre-wrap;">${escapeHtml(customMessage)}</div>`
      : "";

    const resend = new Resend(resendApiKey);
    const EMAIL_LOGO = `<div style="text-align: center; margin-bottom: 24px;"><img src="https://padeltrainer.ai/logo-dark.png" alt="PadelTrainer.ai" width="220" height="40" style="max-width: 220px; height: auto;" /></div>`;

    const { error: sendError } = await resend.emails.send({
      from: "PadelTrainer.ai <noreply@app.padeltrainer.ai>",
      to: [recipientEmail],
      subject: `${tr.subject} ${invoice.invoice_number} - ${formatCurrency(invoice.total)}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          ${EMAIL_LOGO}
          <p style="font-size:16px; color:#1a1a1a; margin:0 0 4px;">${tr.hi} ${escapeHtml(firstName)},</p>
          ${customHtml}
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
      `,
    });

    if (sendError) {
      console.error("Resend error:", sendError);
      return new Response(
        JSON.stringify({ success: false, error: "send_failed", details: sendError }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Stamp sent_at and promote draft -> sent only after a real successful delivery
    try {
      const updates: Record<string, unknown> = {};
      if (!invoice.sent_at) updates.sent_at = new Date().toISOString();
      if (invoice.status === "draft") updates.status = "sent";
      if (Object.keys(updates).length > 0) {
        await supabase.from("invoices").update(updates).eq("id", invoice.id);
      }
    } catch (e) {
      console.error("Failed to update invoice sent_at:", e);
    }

    console.log(`Invoice email sent: ${invoice.invoice_number} to ${recipientEmail}`);

    return new Response(
      JSON.stringify({ success: true, email: recipientEmail }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  } catch (error: any) {
    console.error("Error sending invoice email:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
};

serve(handler);
