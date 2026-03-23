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

    const { invoiceId } = await req.json();
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
    }

    // Build public invoice URL
    const publicUrl = invoice.public_token && slug
      ? `https://padeltrainer.ai/nl/academies/${slug}/pay/${invoice.public_token}`
      : null;

    const formatCurrency = (amount: number) =>
      new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(amount);

    const formatDate = (dateStr: string) => {
      const d = new Date(dateStr);
      return d.toLocaleDateString("nl-NL", { day: "numeric", month: "long", year: "numeric" });
    };

    const resend = new Resend(resendApiKey);
    const EMAIL_LOGO = `<div style="text-align: center; margin-bottom: 24px;"><img src="https://padeltrainer.ai/logo-dark.png" alt="PadelTrainer.ai" width="220" height="40" style="max-width: 220px; height: auto;" /></div>`;

    const { error: sendError } = await resend.emails.send({
      from: "PadelTrainer.ai <noreply@app.padeltrainer.ai>",
      to: [recipientEmail],
      subject: `Factuur ${invoice.invoice_number} - ${formatCurrency(invoice.total)}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          ${EMAIL_LOGO}
          <h2 style="color: #1a1a1a; margin-bottom: 8px;">Factuur ${invoice.invoice_number}</h2>
          <p style="color: #6b7280; margin-bottom: 24px;">Van ${businessName}</p>
          
          <table style="border-collapse: collapse; width: 100%; margin-bottom: 24px;">
            <tr>
              <td style="padding: 8px 12px 8px 0; color: #6b7280; border-bottom: 1px solid #e5e7eb;">Factuurnummer</td>
              <td style="padding: 8px 0; border-bottom: 1px solid #e5e7eb; font-weight: 500;">${invoice.invoice_number}</td>
            </tr>
            <tr>
              <td style="padding: 8px 12px 8px 0; color: #6b7280; border-bottom: 1px solid #e5e7eb;">Factuurdatum</td>
              <td style="padding: 8px 0; border-bottom: 1px solid #e5e7eb;">${formatDate(invoice.invoice_date)}</td>
            </tr>
            <tr>
              <td style="padding: 8px 12px 8px 0; color: #6b7280; border-bottom: 1px solid #e5e7eb;">Vervaldatum</td>
              <td style="padding: 8px 0; border-bottom: 1px solid #e5e7eb;">${formatDate(invoice.due_date)}</td>
            </tr>
            <tr>
              <td style="padding: 8px 12px 8px 0; color: #6b7280; border-bottom: 1px solid #e5e7eb;">Bedrag</td>
              <td style="padding: 8px 0; border-bottom: 1px solid #e5e7eb; font-weight: 700; font-size: 18px;">${formatCurrency(invoice.total)}</td>
            </tr>
            <tr>
              <td style="padding: 8px 12px 8px 0; color: #6b7280;">BTW</td>
              <td style="padding: 8px 0;">${formatCurrency(invoice.vat_amount)} (${invoice.vat_rate}%)</td>
            </tr>
          </table>

          ${publicUrl ? `
            <div style="text-align: center; margin: 32px 0;">
              <a href="${publicUrl}" style="display: inline-block; background: #f45d25; color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px;">
                Bekijk & Betaal Factuur
              </a>
            </div>
            <p style="text-align: center; color: #9ca3af; font-size: 13px; margin-top: 8px;">
              Of kopieer deze link: <a href="${publicUrl}" style="color: #f45d25;">${publicUrl}</a>
            </p>
          ` : ""}
          
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;" />
          <p style="font-size: 12px; color: #9ca3af; text-align: center;">
            Verzonden via PadelTrainer.ai namens ${businessName}
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
