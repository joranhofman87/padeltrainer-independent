import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { decidePublicInvoiceAccess } from "../_shared/publicInvoiceAccess.ts";
import { getPublicInvoiceMollieReadiness } from "../_shared/mollie-payment-ready.ts";

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

    const body = await req.json();
    const { publicToken, action } = body || {};
    if (!publicToken) {
      return new Response(JSON.stringify({ error: "publicToken required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: invoice, error: invError } = await supabase
      .from("invoices")
      .select("id, invoice_number, invoice_date, due_date, player_name, player_id, player_business_name, player_address, player_btw_number, total, subtotal, vat_amount, vat_rate, line_items, notes, status, mollie_payment_url, academy_profile_id, trainer_id, public_token, guest_player_id, public_token_revoked_at")
      .eq("public_token", publicToken)
      .single();

    if (invError || !invoice) {
      return new Response(JSON.stringify({ error: "Invoice not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (invoice.status === "draft") {
      return new Response(JSON.stringify({ error: "draft_invoice" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const access = decidePublicInvoiceAccess(invoice, { action });

    if (access === "paid") {
      return new Response(JSON.stringify({ status: "paid" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (access === "cancelled") {
      return new Response(JSON.stringify({ status: "cancelled" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (access === "not_found") {
      return new Response(JSON.stringify({ error: "Invoice not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (access === "login_required") {
      return new Response(JSON.stringify({ error: "login_required" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Public PDF download is only attempted for unpaid invoices (returns ready: false).
    if (access === "download") {
      return new Response(JSON.stringify({ ready: false, status: invoice.status }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Look up guest player email if no registered player
    let playerEmail: string | null = null;
    if (!invoice.player_id && invoice.guest_player_id) {
      const { data: guestData } = await supabase
        .from("guest_players")
        .select("email")
        .eq("id", invoice.guest_player_id)
        .maybeSingle();
      playerEmail = guestData?.email || null;
    }

    let academy = null;
    if (invoice.academy_profile_id) {
      const { data: academyData } = await supabase
        .from("academy_profiles")
        .select("name, slug, invoice_logo_url, invoice_banner_color, contact_email, invoice_reply_to_email, business_name, business_address, kvk_number, btw_number, iban, bic")
        .eq("id", invoice.academy_profile_id)
        .single();
      academy = academyData;
    }

    const mollieReadiness = await getPublicInvoiceMollieReadiness(supabase, invoice);

    // invoice_logo_url stores a full public URL from the avatars bucket — use directly
    const logoUrl = academy?.invoice_logo_url || null;

    return new Response(JSON.stringify({
      invoice: {
        id: invoice.id,
        invoiceNumber: invoice.invoice_number,
        invoiceDate: invoice.invoice_date,
        dueDate: invoice.due_date,
        playerName: invoice.player_name,
        playerId: invoice.player_id,
        playerEmail,
        playerBusinessName: invoice.player_business_name,
        playerAddress: invoice.player_address,
        playerBtwNumber: invoice.player_btw_number,
        total: invoice.total,
        subtotal: invoice.subtotal,
        vatAmount: invoice.vat_amount,
        vatRate: invoice.vat_rate,
        lineItems: invoice.line_items,
        notes: invoice.notes ?? null,
        status: invoice.status,
        hasMolliePayment: !!invoice.mollie_payment_url,
        hasMollieAccount: mollieReadiness.hasMollieAccount,
        paymentUnavailableReason: mollieReadiness.paymentUnavailableReason ?? null,
        paymentRecipient: mollieReadiness.paymentRecipient,
      },
      academy: academy ? {
        name: academy.name,
        slug: academy.slug,
        logoUrl,
        bannerColor: academy.invoice_banner_color,
        contactEmail: academy.contact_email,
        invoiceReplyToEmail: academy.invoice_reply_to_email,
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
    // Log full detail server-side; never echo raw DB error text to callers.
    console.error("get-public-invoice error:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
