import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[CREATE-ACADEMY-MOLLIE-SUBSCRIPTION] ${step}`, details ? JSON.stringify(details) : "");
};

// Academy subscription plan
const PLAN = {
  amount: "199.00",
  interval: "1 month",
  description: "Academy Plan - Monthly",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const mollieApiKey = Deno.env.get("MOLLIE_API_KEY");
    if (!mollieApiKey) throw new Error("MOLLIE_API_KEY is not set");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Authenticate user
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header");

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData.user) throw new Error("Authentication failed");
    
    const user = userData.user;
    logStep("User authenticated", { userId: user.id, email: user.email });

    const { academyProfileId } = await req.json();
    if (!academyProfileId) throw new Error("Academy profile ID required");

    logStep("Academy profile ID", { academyProfileId });

    // Verify user is a manager of this academy
    const { data: academyProfile, error: academyError } = await supabase
      .from("academy_profiles")
      .select("id, name, mollie_customer_id, academy_managers!inner(user_id)")
      .eq("id", academyProfileId)
      .eq("academy_managers.user_id", user.id)
      .single();

    if (academyError || !academyProfile) {
      throw new Error("Academy profile not found or access denied");
    }

    let customerId = academyProfile.mollie_customer_id;
    const origin = req.headers.get("origin") || "https://padeltrainer.ai";

    // Create Mollie customer if needed
    if (!customerId) {
      const customerResponse = await fetch("https://api.mollie.com/v2/customers", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${mollieApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: academyProfile.name || user.email,
          email: user.email,
          metadata: { academy_profile_id: academyProfile.id },
        }),
      });

      if (!customerResponse.ok) {
        const errorText = await customerResponse.text();
        throw new Error(`Failed to create customer: ${errorText}`);
      }

      const customer = await customerResponse.json();
      customerId = customer.id;

      await supabase
        .from("academy_profiles")
        .update({ mollie_customer_id: customerId })
        .eq("id", academyProfile.id);

      logStep("Customer created", { customerId });
    }

    // Check for existing active subscription
    const subsResponse = await fetch(
      `https://api.mollie.com/v2/customers/${customerId}/subscriptions?status=active`,
      {
        headers: { "Authorization": `Bearer ${mollieApiKey}` },
      }
    );

    if (subsResponse.ok) {
      const subs = await subsResponse.json();
      if (subs.count > 0) {
        logStep("Active subscription exists");
        return new Response(
          JSON.stringify({ 
            hasActiveSubscription: true,
            message: "You already have an active subscription" 
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Create first payment to get mandate for subscription
    const paymentResponse = await fetch("https://api.mollie.com/v2/payments", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${mollieApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: { currency: "EUR", value: PLAN.amount },
        description: `${PLAN.description} - First payment`,
        redirectUrl: `${origin}/academy/subscription?success=true`,
        webhookUrl: `${supabaseUrl}/functions/v1/mollie-subscription-webhook`,
        customerId,
        sequenceType: "first",
        metadata: {
          academy_profile_id: academyProfile.id,
          type: "academy_subscription_first_payment",
        },
      }),
    });

    if (!paymentResponse.ok) {
      const errorText = await paymentResponse.text();
      throw new Error(`Failed to create payment: ${errorText}`);
    }

    const payment = await paymentResponse.json();
    logStep("First payment created", { paymentId: payment.id });

    // Store pending subscription info
    await supabase
      .from("academy_profiles")
      .update({ 
        subscription_status: "pending",
        subscription_tier: "academy",
      })
      .eq("id", academyProfile.id);

    return new Response(
      JSON.stringify({
        paymentId: payment.id,
        checkoutUrl: payment._links.checkout.href,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message });
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
