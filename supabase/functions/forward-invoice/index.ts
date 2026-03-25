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
        JSON.stringify({ error: "Email service not configured" }),
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

    // Allow service-role calls (from auto-create-invoice) to skip user ownership check
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

    const { invoiceId } = await req.json();
    if (!invoiceId) {
      return new Response(
        JSON.stringify({ error: "Missing invoiceId" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Fetch invoice
    const { data: invoice, error: invoiceError } = await supabase
      .from("invoices")
      .select("*")
      .eq("id", invoiceId)
      .single();

    if (invoiceError || !invoice) {
      return new Response(
        JSON.stringify({ error: "Invoice not found" }),
        { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Fetch trainer profile with forward emails
    const { data: trainerProfile } = await supabase
      .from("trainer_profiles")
      .select("user_id, invoice_forward_emails, business_name")
      .eq("id", invoice.trainer_id)
      .single();

    // Check authorization
    if (!isServiceRole) {
      let authorized = trainerProfile?.user_id === authenticatedUserId;
      
      // Also allow academy managers
      if (!authorized && invoice.academy_profile_id) {
        const { data: isManager } = await supabase
          .rpc("is_academy_manager", { _user_id: authenticatedUserId, _academy_profile_id: invoice.academy_profile_id });
        authorized = !!isManager;
      }

      if (!authorized) {
        return new Response(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
    }

    // Resolve forwarding emails: try trainer first, then academy fallback
    let emails = trainerProfile?.invoice_forward_emails;
    let businessName = trainerProfile?.business_name;

    if ((!emails || emails.length === 0) && invoice.academy_profile_id) {
      const { data: academy } = await supabase
        .from("academy_profiles")
        .select("invoice_forward_emails, business_name")
        .eq("id", invoice.academy_profile_id)
        .single();
      if (academy?.invoice_forward_emails?.length) {
        emails = academy.invoice_forward_emails;
        businessName = academy.business_name || businessName;
      }
    }

    if (!emails || emails.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: "No forwarding emails configured" }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Generate a fresh signed URL for the invoice
    const fileName = `${trainerProfile!.user_id}/${invoice.invoice_number}.html`;
    const { data: signedUrl } = await supabase.storage
      .from("invoices")
      .createSignedUrl(fileName, 604800); // 7 days

    const pdfLink = signedUrl?.signedUrl || invoice.pdf_url || "";

    const formatCurrency = (amount: number) =>
      new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(amount);

    const resend = new Resend(resendApiKey);

    const EMAIL_LOGO = `<div style="text-align: center; margin-bottom: 24px;"><img src="https://padeltrainer.ai/logo-dark.png" alt="PadelTrainer.ai" width="220" height="40" style="max-width: 220px; height: auto;" /></div>`;

    const emailPromises = emails.map((email: string) =>
      resend.emails.send({
        from: "PadelTrainer.ai <noreply@app.padeltrainer.ai>",
        to: [email],
        subject: `Factuur ${invoice.invoice_number} - ${invoice.player_name} - ${formatCurrency(invoice.total)}`,
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
      })
    );

    const results = await Promise.allSettled(emailPromises);
    const failed = results.filter((r) => r.status === "rejected").length;

    console.log(`Forward invoice ${invoice.invoice_number}: sent to ${emails.length - failed}/${emails.length} addresses`);

    return new Response(
      JSON.stringify({ success: true, sent: emails.length - failed, failed }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  } catch (error: any) {
    console.error("Error forwarding invoice:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
};

serve(handler);
