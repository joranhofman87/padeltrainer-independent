import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[CREATE-INVOICE-PAYMENT] ${step}`, details ? JSON.stringify(details) : "");
};

async function refreshTokenIfNeeded(
  supabaseClient: any,
  accountData: any,
  entityType: "trainer" | "academy",
  entityId: string
): Promise<string | null> {
  const mollieClientId = Deno.env.get("MOLLIE_CLIENT_ID");
  const mollieClientSecret = Deno.env.get("MOLLIE_CLIENT_SECRET");
  if (!mollieClientId || !mollieClientSecret) return accountData.access_token;

  const tokenExpiresAt = new Date(accountData.token_expires_at);
  const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);
  if (tokenExpiresAt > fiveMinutesFromNow) return accountData.access_token;

  if (!accountData.refresh_token) return accountData.access_token;

  try {
    const tokenResponse = await fetch("https://api.mollie.com/oauth2/tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${btoa(`${mollieClientId}:${mollieClientSecret}`)}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: accountData.refresh_token,
      }),
    });

    if (!tokenResponse.ok) return accountData.access_token;

    const tokens = await tokenResponse.json();
    const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
    const tableName = entityType === "trainer" ? "trainer_mollie_accounts" : "academy_mollie_accounts";
    const idColumn = entityType === "trainer" ? "trainer_id" : "academy_profile_id";

    await supabaseClient
      .from(tableName)
      .update({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expires_at: newExpiresAt,
        updated_at: new Date().toISOString(),
      })
      .eq(idColumn, entityId);

    return tokens.access_token;
  } catch {
    return accountData.access_token;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const mollieApiKey = Deno.env.get("MOLLIE_API_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { invoiceId } = await req.json();
    if (!invoiceId) {
      return new Response(JSON.stringify({ error: "invoiceId required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch invoice
    const { data: invoice, error: invError } = await supabase
      .from("invoices")
      .select("id, invoice_number, total, player_name, player_id, trainer_id, academy_profile_id, status, mollie_payment_id, mollie_payment_url, public_token")
      .eq("id", invoiceId)
      .single();

    if (invError || !invoice) {
      logStep("Invoice not found", { invoiceId });
      return new Response(JSON.stringify({ error: "Invoice not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // If already has a payment URL that's not paid, return it
    if (invoice.mollie_payment_url && invoice.status !== "paid") {
      return new Response(JSON.stringify({ paymentUrl: invoice.mollie_payment_url, existing: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Resolve Mollie access token — prefer academy, fall back to trainer
    let accessToken: string | null = null;

    if (invoice.academy_profile_id) {
      const { data: academyMollie } = await supabase
        .from("academy_mollie_accounts")
        .select("access_token, refresh_token, token_expires_at, charges_enabled")
        .eq("academy_profile_id", invoice.academy_profile_id)
        .eq("onboarding_complete", true)
        .single();

      if (academyMollie?.access_token && academyMollie?.charges_enabled) {
        accessToken = await refreshTokenIfNeeded(supabase, academyMollie, "academy", invoice.academy_profile_id);
      }
    }

    if (!accessToken && invoice.trainer_id) {
      const { data: trainerMollie } = await supabase
        .from("trainer_mollie_accounts")
        .select("access_token, refresh_token, token_expires_at")
        .eq("trainer_id", invoice.trainer_id)
        .eq("onboarding_complete", true)
        .single();

      if (trainerMollie?.access_token) {
        accessToken = await refreshTokenIfNeeded(supabase, trainerMollie, "trainer", invoice.trainer_id);
      }
    }

    const isTestMode = mollieApiKey.startsWith("test_");
    const authToken = accessToken || mollieApiKey;

    // Build redirect URL
    const appUrl = Deno.env.get("APP_URL") || `https://padeltrainer.ai`;
    let redirectUrl: string;

    if (invoice.public_token && invoice.academy_profile_id) {
      // Fetch academy slug for branded URL
      const { data: academyData } = await supabase
        .from("academy_profiles")
        .select("slug")
        .eq("id", invoice.academy_profile_id)
        .single();
      const slug = academyData?.slug;
      redirectUrl = slug
        ? `${appUrl}/nl/academies/${slug}/pay/${invoice.public_token}?status=success`
        : `${appUrl}/pay/${invoice.public_token}?status=success`;
    } else if (invoice.public_token) {
      redirectUrl = `${appUrl}/pay/${invoice.public_token}?status=success`;
    } else {
      redirectUrl = `${appUrl}/app/booking-success?invoice=${invoice.invoice_number}`;
    }
    const webhookUrl = `${supabaseUrl}/functions/v1/mollie-webhook`;

    // Create Mollie payment
    const paymentBody: Record<string, unknown> = {
      amount: {
        currency: "EUR",
        value: invoice.total.toFixed(2),
      },
      description: `Factuur ${invoice.invoice_number}`,
      redirectUrl,
      webhookUrl,
      metadata: {
        invoice_id: invoice.id,
      },
    };

    if (isTestMode && accessToken) {
      paymentBody.testmode = true;
    }

    logStep("Creating Mollie payment", { invoiceNumber: invoice.invoice_number, amount: invoice.total });

    const mollieRes = await fetch("https://api.mollie.com/v2/payments", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(paymentBody),
    });

    if (!mollieRes.ok) {
      const errText = await mollieRes.text();
      logStep("Mollie payment creation failed", { error: errText });
      throw new Error(`Mollie error: ${errText}`);
    }

    const molliePayment = await mollieRes.json();
    const checkoutUrl = molliePayment._links?.checkout?.href;

    // Update invoice with payment info
    await supabase
      .from("invoices")
      .update({
        mollie_payment_id: molliePayment.id,
        mollie_payment_url: checkoutUrl,
      })
      .eq("id", invoice.id);

    logStep("Payment created", { paymentId: molliePayment.id, checkoutUrl });

    return new Response(JSON.stringify({ paymentUrl: checkoutUrl, paymentId: molliePayment.id }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message });
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
