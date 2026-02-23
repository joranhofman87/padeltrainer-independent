import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[CREATE-MOLLIE-SUBSCRIPTION] ${step}`, details ? JSON.stringify(details) : "");
};

// Trainer subscription plans
const PLANS: Record<string, { amount: string; interval: string; description: string }> = {
  starter: { amount: "19.00", interval: "1 month", description: "Starter Plan - Monthly" },
  professional: { amount: "39.00", interval: "1 month", description: "Professional Plan - Monthly" },
  starter_yearly: { amount: "190.00", interval: "12 months", description: "Starter Plan - Yearly" },
  professional_yearly: { amount: "390.00", interval: "12 months", description: "Professional Plan - Yearly" },
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

    const { planId } = await req.json();
    const plan = PLANS[planId];
    if (!plan) throw new Error(`Invalid plan: ${planId}`);

    logStep("Plan selected", { planId, plan });

    // Get trainer profile
    const { data: trainerProfile } = await supabase
      .from("trainer_profiles")
      .select("id, mollie_customer_id, subscription_id, subscription_tier, subscription_status")
      .eq("user_id", user.id)
      .single();

    if (!trainerProfile) throw new Error("Trainer profile not found");

    let customerId = trainerProfile.mollie_customer_id;
    const origin = req.headers.get("origin") || "https://padeltrainer.ai";

    // Determine the requested tier (without _yearly suffix)
    const requestedTier = planId.replace("_yearly", "");

    // Block same-plan re-subscription
    if (
      trainerProfile.subscription_status === "active" &&
      trainerProfile.subscription_tier === requestedTier
    ) {
      logStep("Already on this plan", { currentTier: trainerProfile.subscription_tier });
      return new Response(
        JSON.stringify({
          hasActiveSubscription: true,
          message: "You are already on this plan",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

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
          metadata: { trainer_profile_id: trainerProfile.id },
        }),
      });

      if (!customerResponse.ok) {
        const errorText = await customerResponse.text();
        throw new Error(`Failed to create customer: ${errorText}`);
      }

      const customer = await customerResponse.json();
      customerId = customer.id;

      await supabase
        .from("trainer_profiles")
        .update({ mollie_customer_id: customerId })
        .eq("id", trainerProfile.id);

      logStep("Customer created", { customerId });
    }

    // If there's an existing active subscription on a DIFFERENT plan, cancel it at end of period
    if (
      trainerProfile.subscription_status === "active" &&
      trainerProfile.subscription_id &&
      trainerProfile.subscription_tier !== requestedTier
    ) {
      logStep("Cancelling existing subscription for plan switch", {
        oldTier: trainerProfile.subscription_tier,
        newTier: requestedTier,
        subscriptionId: trainerProfile.subscription_id,
      });

      try {
        const cancelResponse = await fetch(
          `https://api.mollie.com/v2/customers/${customerId}/subscriptions/${trainerProfile.subscription_id}`,
          {
            method: "DELETE",
            headers: { "Authorization": `Bearer ${mollieApiKey}` },
          }
        );

        if (cancelResponse.ok || cancelResponse.status === 404) {
          logStep("Old subscription cancelled (or already gone)");
        } else {
          const errText = await cancelResponse.text();
          logStep("Warning: failed to cancel old subscription", { error: errText });
          // Continue anyway – we still want to create the new subscription
        }
      } catch (cancelErr) {
        logStep("Warning: cancel request failed", { error: String(cancelErr) });
      }

      // Clear old subscription ID so webhook doesn't skip
      await supabase
        .from("trainer_profiles")
        .update({ subscription_id: null })
        .eq("id", trainerProfile.id);
    }

    // Look up active discount for this user
    let paymentAmount = plan.amount;
    let discountPercent = 0;
    const { data: discount } = await supabase
      .from("user_discounts")
      .select("discount_percent, months_remaining")
      .eq("user_id", user.id)
      .eq("is_active", true)
      .gt("months_remaining", 0)
      .maybeSingle();

    if (discount) {
      discountPercent = discount.discount_percent;
      const original = parseFloat(plan.amount);
      paymentAmount = (original * (1 - discountPercent / 100)).toFixed(2);
      logStep("Discount applied", { discountPercent, original: plan.amount, discounted: paymentAmount });
    }

    // Create first payment to get mandate for subscription
    const paymentResponse = await fetch("https://api.mollie.com/v2/payments", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${mollieApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: { currency: "EUR", value: paymentAmount },
        description: `${plan.description} - First payment`,
        redirectUrl: `${origin}/app/trainer/subscription?success=true&plan=${planId}`,
        webhookUrl: `${supabaseUrl}/functions/v1/mollie-subscription-webhook`,
        customerId,
        sequenceType: "first",
        metadata: {
          trainer_profile_id: trainerProfile.id,
          plan_id: planId,
          type: "subscription_first_payment",
          discount_percent: discountPercent || undefined,
          original_amount: discountPercent ? plan.amount : undefined,
          user_id: user.id,
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
      .from("trainer_profiles")
      .update({ 
        subscription_status: "pending",
        subscription_tier: requestedTier,
      })
      .eq("id", trainerProfile.id);

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
