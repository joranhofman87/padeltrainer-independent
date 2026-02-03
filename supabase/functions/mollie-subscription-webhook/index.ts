import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[MOLLIE-SUBSCRIPTION-WEBHOOK] ${step}`, details ? JSON.stringify(details) : "");
};

// Plan configurations
const TRAINER_PLANS: Record<string, { amount: string; interval: string; times?: number }> = {
  starter: { amount: "19.00", interval: "1 month" },
  professional: { amount: "39.00", interval: "1 month" },
  starter_yearly: { amount: "190.00", interval: "12 months", times: 1 },
  professional_yearly: { amount: "390.00", interval: "12 months", times: 1 },
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

    // Mollie sends payment ID in the body
    const formData = await req.formData();
    const paymentId = formData.get("id") as string;

    if (!paymentId) {
      logStep("No payment ID in webhook");
      return new Response("OK", { status: 200 });
    }

    logStep("Webhook received", { paymentId });

    // Fetch payment details from Mollie
    const paymentResponse = await fetch(`https://api.mollie.com/v2/payments/${paymentId}`, {
      headers: { "Authorization": `Bearer ${mollieApiKey}` },
    });

    if (!paymentResponse.ok) {
      throw new Error("Failed to fetch payment");
    }

    const payment = await paymentResponse.json();
    logStep("Payment fetched", { status: payment.status, metadata: payment.metadata });

    if (payment.status !== "paid") {
      logStep("Payment not paid yet", { status: payment.status });
      return new Response("OK", { status: 200 });
    }

    const metadata = payment.metadata || {};
    const customerId = payment.customerId;

    // Handle trainer subscription
    if (metadata.type === "subscription_first_payment" && metadata.trainer_profile_id) {
      const planId = metadata.plan_id;
      const plan = TRAINER_PLANS[planId];

      if (!plan) {
        logStep("Invalid plan ID", { planId });
        return new Response("OK", { status: 200 });
      }

      // Create the actual subscription now that we have a mandate
      const subscriptionData: Record<string, unknown> = {
        amount: { currency: "EUR", value: plan.amount },
        interval: plan.interval,
        description: `Trainer subscription - ${planId}`,
        webhookUrl: `${supabaseUrl}/functions/v1/mollie-subscription-webhook`,
        metadata: {
          trainer_profile_id: metadata.trainer_profile_id,
          plan_id: planId,
          type: "trainer_subscription",
        },
      };

      if (plan.times) {
        subscriptionData.times = plan.times;
      }

      const subResponse = await fetch(
        `https://api.mollie.com/v2/customers/${customerId}/subscriptions`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${mollieApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(subscriptionData),
        }
      );

      if (!subResponse.ok) {
        const errorText = await subResponse.text();
        logStep("Failed to create subscription", { error: errorText });
        throw new Error(`Failed to create subscription: ${errorText}`);
      }

      const subscription = await subResponse.json();
      logStep("Subscription created", { subscriptionId: subscription.id });

      // Calculate subscription end date
      const endDate = new Date();
      if (plan.interval === "12 months") {
        endDate.setFullYear(endDate.getFullYear() + 1);
      } else {
        endDate.setMonth(endDate.getMonth() + 1);
      }

      // Update trainer profile
      await supabase
        .from("trainer_profiles")
        .update({
          subscription_status: "active",
          subscription_tier: planId.replace("_yearly", ""),
          subscription_id: subscription.id,
          subscription_ends_at: endDate.toISOString(),
        })
        .eq("id", metadata.trainer_profile_id);

      logStep("Trainer subscription activated");
    }

    // Handle club subscription
    if (metadata.type === "club_subscription_first_payment" && metadata.club_profile_id) {
      const billingCycle = metadata.billing_cycle || "yearly";
      const planAmount = metadata.plan_amount || "2388.00";
      const trialEndsAt = metadata.trial_ends_at;

      // Create subscription starting after trial
      const startDate = trialEndsAt ? new Date(trialEndsAt) : new Date();
      
      const subResponse = await fetch(
        `https://api.mollie.com/v2/customers/${customerId}/subscriptions`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${mollieApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            amount: { currency: "EUR", value: planAmount },
            interval: billingCycle === "yearly" ? "12 months" : "1 month",
            startDate: startDate.toISOString().split("T")[0],
            description: `Club subscription - ${billingCycle}`,
            webhookUrl: `${supabaseUrl}/functions/v1/mollie-subscription-webhook`,
            metadata: {
              club_profile_id: metadata.club_profile_id,
              type: "club_subscription",
            },
          }),
        }
      );

      if (!subResponse.ok) {
        const errorText = await subResponse.text();
        logStep("Failed to create club subscription", { error: errorText });
        throw new Error(`Failed to create subscription: ${errorText}`);
      }

      const subscription = await subResponse.json();
      logStep("Club subscription created", { subscriptionId: subscription.id });

      // Update club profile
      await supabase
        .from("club_profiles")
        .update({
          subscription_id: subscription.id,
          subscription_tier: "club",
        })
        .eq("id", metadata.club_profile_id);

      logStep("Club subscription setup complete");
    }

    // Handle recurring subscription payments
    if (metadata.type === "trainer_subscription" || metadata.type === "club_subscription") {
      const profileField = metadata.type === "trainer_subscription" 
        ? "trainer_profile_id" 
        : "club_profile_id";
      const table = metadata.type === "trainer_subscription" 
        ? "trainer_profiles" 
        : "club_profiles";

      // Calculate new end date
      const endDate = new Date();
      endDate.setMonth(endDate.getMonth() + (metadata.type === "club_subscription" ? 12 : 1));

      await supabase
        .from(table)
        .update({
          subscription_status: "active",
          subscription_ends_at: endDate.toISOString(),
        })
        .eq("id", metadata[profileField]);

      logStep("Recurring payment processed", { type: metadata.type });
    }

    return new Response("OK", { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message });
    return new Response("OK", { status: 200 });
  }
});
