import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[CREATE-CLUB-MOLLIE-SUBSCRIPTION] ${step}`, details ? JSON.stringify(details) : "");
};

const PLANS: Record<string, { amount: string; interval: string; description: string }> = {
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

    const plan = PLANS[billingCycle] || PLANS.yearly;
    logStep("Plan selected", { billingCycle, plan });

    // Verify user is a manager of this club
    const { data: clubProfile, error: clubError } = await supabase
      .from("club_profiles")
      .select("id, mollie_customer_id, location_id, club_managers!inner(user_id)")
      .eq("id", clubProfileId)
      .eq("club_managers.user_id", user.id)
      .single();

    if (clubError || !clubProfile) {
      throw new Error("Club profile not found or access denied");
    }

    // Get club name from location
    const { data: location } = await supabase
      .from("locations")
      .select("name")
      .eq("id", clubProfile.location_id)
      .single();

    let customerId = clubProfile.mollie_customer_id;
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
          name: location?.name || user.email,
          email: user.email,
          metadata: { club_profile_id: clubProfile.id },
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
        .eq("id", clubProfile.id);

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
            message: "You already have an active subscription",
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
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
        redirectUrl: `${origin}/club/subscription?success=true`,
        webhookUrl: `${supabaseUrl}/functions/v1/mollie-subscription-webhook`,
        customerId,
        sequenceType: "first",
        metadata: {
          club_profile_id: clubProfile.id,
          billing_cycle: billingCycle,
          plan_amount: plan.amount,
          trial_ends_at: null,
          type: "club_subscription_first_payment",
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
      .from("club_profiles")
      .update({
        subscription_status: "pending",
        subscription_tier: "club",
      })
      .eq("id", clubProfile.id);

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
