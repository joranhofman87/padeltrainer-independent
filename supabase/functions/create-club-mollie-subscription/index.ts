import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[CREATE-CLUB-MOLLIE-SUBSCRIPTION] ${step}`, details ? JSON.stringify(details) : "");
};

// Club subscription plan - €199/month or €2388/year
const CLUB_PLAN = {
  monthly: { amount: "199.00", interval: "1 month", description: "Club Plan - Monthly" },
  yearly: { amount: "2388.00", interval: "12 months", description: "Club Plan - Yearly" },
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

    const { clubProfileId, billingCycle = "yearly" } = await req.json();
    if (!clubProfileId) throw new Error("Club profile ID required");

    const plan = CLUB_PLAN[billingCycle as keyof typeof CLUB_PLAN] || CLUB_PLAN.yearly;
    logStep("Plan selected", { billingCycle, plan });

    // Verify user is club manager
    const { data: clubProfile, error: clubError } = await supabase
      .from("club_profiles")
      .select("*, club_managers!inner(user_id)")
      .eq("id", clubProfileId)
      .eq("club_managers.user_id", user.id)
      .single();

    if (clubError || !clubProfile) throw new Error("Club not found or access denied");

    let customerId = clubProfile.mollie_customer_id;
    const origin = req.headers.get("origin") || "https://app.padeltrainer.ai";

    // Create Mollie customer if needed
    if (!customerId) {
      const customerResponse = await fetch("https://api.mollie.com/v2/customers", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${mollieApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: user.user_metadata?.full_name || user.email,
          email: user.email,
          metadata: { club_profile_id: clubProfileId },
        }),
      });

      if (!customerResponse.ok) {
        const errorText = await customerResponse.text();
        throw new Error(`Failed to create customer: ${errorText}`);
      }

      const customer = await customerResponse.json();
      customerId = customer.id;

      await supabase
        .from("club_profiles")
        .update({ mollie_customer_id: customerId })
        .eq("id", clubProfileId);

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
            message: "Club already has an active subscription" 
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Create first payment with trial (14 days free)
    const trialEndDate = new Date();
    trialEndDate.setDate(trialEndDate.getDate() + 14);

    const paymentResponse = await fetch("https://api.mollie.com/v2/payments", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${mollieApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: { currency: "EUR", value: "0.01" }, // Minimal amount for mandate
        description: `Club subscription setup - 14-day trial`,
        redirectUrl: `${origin}/club/subscription?success=true`,
        webhookUrl: `${supabaseUrl}/functions/v1/mollie-subscription-webhook`,
        customerId,
        sequenceType: "first",
        metadata: {
          club_profile_id: clubProfileId,
          billing_cycle: billingCycle,
          type: "club_subscription_first_payment",
          trial_ends_at: trialEndDate.toISOString(),
          plan_amount: plan.amount,
        },
      }),
    });

    if (!paymentResponse.ok) {
      const errorText = await paymentResponse.text();
      throw new Error(`Failed to create payment: ${errorText}`);
    }

    const payment = await paymentResponse.json();
    logStep("First payment created", { paymentId: payment.id });

    // Update club with trial info
    await supabase
      .from("club_profiles")
      .update({ 
        subscription_status: "trialing",
        trial_ends_at: trialEndDate.toISOString(),
      })
      .eq("id", clubProfileId);

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
