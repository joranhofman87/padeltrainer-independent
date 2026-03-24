import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { publicToken } = await req.json();
    if (!publicToken) {
      return new Response(JSON.stringify({ error: "publicToken required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: invoice, error: invError } = await supabase
      .from("invoices")
      .select("id, invoice_number, invoice_date, due_date, player_name, total, subtotal, vat_amount, vat_rate, line_items, status, mollie_payment_url, academy_profile_id, trainer_id, public_token")
      .eq("public_token", publicToken)
      .single();

    if (invError || !invoice) {
      return new Response(JSON.stringify({ error: "Invoice not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (invoice.status === "paid" || invoice.status === "cancelled") {
      return new Response(JSON.stringify({
        error: invoice.status === "paid" ? "already_paid" : "cancelled",
        invoiceNumber: invoice.invoice_number,
        status: invoice.status,
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let academy = null;
    let hasMollieAccount = false;
    if (invoice.academy_profile_id) {
      const { data: academyData } = await supabase
        .from("academy_profiles")
        .select("name, slug, invoice_logo_url, invoice_banner_color, contact_email, business_name, business_address, kvk_number, btw_number, iban, bic")
        .eq("id", invoice.academy_profile_id)
        .single();
      academy = academyData;

      // Check if academy has a connected Mollie account
      const { data: mollieAccount } = await supabase
        .from("academy_mollie_accounts")
        .select("charges_enabled, onboarding_complete")
        .eq("academy_profile_id", invoice.academy_profile_id)
        .maybeSingle();

      hasMollieAccount = !!(mollieAccount?.charges_enabled && mollieAccount?.onboarding_complete);
    }

    // If no academy Mollie, check trainer
    if (!hasMollieAccount && invoice.trainer_id) {
      const { data: trainerMollie } = await supabase
        .from("trainer_mollie_accounts")
        .select("onboarding_complete")
        .eq("trainer_id", invoice.trainer_id)
        .eq("onboarding_complete", true)
        .maybeSingle();

      hasMollieAccount = !!trainerMollie;
    }

    // invoice_logo_url stores a full public URL from the avatars bucket — use directly
    const logoUrl = academy?.invoice_logo_url || null;

    return new Response(JSON.stringify({
      invoice: {
        id: invoice.id,
        invoiceNumber: invoice.invoice_number,
        invoiceDate: invoice.invoice_date,
        dueDate: invoice.due_date,
        playerName: invoice.player_name,
        total: invoice.total,
        subtotal: invoice.subtotal,
        vatAmount: invoice.vat_amount,
        vatRate: invoice.vat_rate,
        lineItems: invoice.line_items,
        status: invoice.status,
        hasMolliePayment: !!invoice.mollie_payment_url,
        hasMollieAccount,
      },
      academy: academy ? {
        name: academy.name,
        slug: academy.slug,
        logoUrl,
        bannerColor: academy.invoice_banner_color,
        contactEmail: academy.contact_email,
        businessName: academy.business_name,
        businessAddress: academy.business_address,
        kvkNumber: academy.kvk_number,
        btwNumber: academy.btw_number,
        iban: academy.iban,
        bic: academy.bic,
      } : null,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
