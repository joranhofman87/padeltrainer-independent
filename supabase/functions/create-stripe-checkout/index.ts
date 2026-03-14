import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[CREATE-STRIPE-CHECKOUT] ${step}`, details ? JSON.stringify(details) : "");
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) throw new Error("STRIPE_SECRET_KEY is not set");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header");

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData.user) throw new Error("Authentication failed");

    const user = userData.user;
    logStep("User authenticated", { userId: user.id, email: user.email });

    const { type = "trainer", profileId, planId, billingCycle = "monthly" } = await req.json();

    // Determine the profile and current subscription state
    let profile: any;
    let table: string;

    if (type === "trainer") {
      table = "trainer_profiles";
      const { data, error } = await supabase
        .from("trainer_profiles")
        .select("id, stripe_customer_id, subscription_status, subscription_tier, subscription_id")
        .eq("user_id", user.id)
        .single();
      if (error || !data) throw new Error("Trainer profile not found");
      profile = data;
    } else if (type === "academy") {
      table = "academy_profiles";
      if (!profileId) throw new Error("Academy profile ID required");
      const { data, error } = await supabase
        .from("academy_profiles")
        .select("id, stripe_customer_id, subscription_status, subscription_tier, subscription_id, academy_managers!inner(user_id)")
        .eq("id", profileId)
        .eq("academy_managers.user_id", user.id)
        .single();
      if (error || !data) throw new Error("Academy profile not found or access denied");
      profile = data;
    } else if (type === "club") {
      table = "club_profiles";
      if (!profileId) throw new Error("Club profile ID required");
      const { data, error } = await supabase
        .from("club_profiles")
        .select("id, stripe_customer_id, subscription_status, subscription_tier, subscription_id, club_managers!inner(user_id)")
        .eq("id", profileId)
        .eq("club_managers.user_id", user.id)
        .single();
      if (error || !data) throw new Error("Club profile not found or access denied");
      profile = data;
    } else {
      throw new Error("Invalid type. Use 'trainer', 'academy', or 'club'");
    }

    // Look up the plan from subscription_plans table
    const tier = planId || (type === "club" ? "club" : type === "academy" ? "academy" : "professional");
    const planType = type === "trainer" ? "trainer" : type;

    const { data: plan, error: planError } = await supabase
      .from("subscription_plans")
      .select("id, stripe_price_id_monthly, stripe_price_id_yearly, tier, name")
      .eq("tier", tier)
      .eq("plan_type", planType)
      .eq("is_active", true)
      .single();

    if (planError || !plan) throw new Error(`Plan not found: ${tier}/${planType}`);

    const priceId = billingCycle === "yearly" ? plan.stripe_price_id_yearly : plan.stripe_price_id_monthly;
    if (!priceId) throw new Error(`No Stripe price configured for ${tier} ${billingCycle}`);

    logStep("Plan selected", { tier, billingCycle, priceId });

    // Block same-plan re-subscription
    if (profile.subscription_status === "active" && profile.subscription_tier === tier) {
      return new Response(
        JSON.stringify({ hasActiveSubscription: true, message: "You are already on this plan" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });
    const origin = req.headers.get("origin") || "https://padeltrainer.ai";

    // Resolve Stripe customer: check profiles table first, then entity profile, then Stripe
    let customerId = profile.stripe_customer_id;

    if (!customerId) {
      // Check the central profiles table
      const { data: centralProfile } = await supabase
        .from("profiles")
        .select("stripe_customer_id")
        .eq("user_id", user.id)
        .single();
      
      if (centralProfile?.stripe_customer_id) {
        customerId = centralProfile.stripe_customer_id;
        logStep("Customer ID from profiles table", { customerId });
      }
    }

    if (!customerId) {
      // Search Stripe or create new customer
      const customers = await stripe.customers.list({ email: user.email!, limit: 1 });
      if (customers.data.length > 0) {
        customerId = customers.data[0].id;
      } else {
        const customer = await stripe.customers.create({
          email: user.email!,
          name: user.user_metadata?.full_name || user.email,
          metadata: { profile_id: profile.id, type, user_id: user.id },
        });
        customerId = customer.id;
      }
      // Save to profiles table
      await supabase.from("profiles").update({ stripe_customer_id: customerId }).eq("user_id", user.id);
      logStep("Stripe customer saved to profiles", { customerId });
    }

    // Also ensure entity profile has the customer ID
    if (!profile.stripe_customer_id) {
      await supabase.from(table).update({ stripe_customer_id: customerId }).eq("id", profile.id);
    }

    // If switching plans, cancel existing subscription at period end
    if (profile.subscription_status === "active" && profile.subscription_id && profile.subscription_tier !== tier) {
      try {
        await stripe.subscriptions.update(profile.subscription_id, { cancel_at_period_end: true });
        logStep("Old subscription set to cancel at period end", { subscriptionId: profile.subscription_id });
      } catch (e) {
        logStep("Warning: failed to cancel old subscription", { error: String(e) });
      }
    }

    // Check for active discount — use stored Stripe coupon ID if available
    let discounts: Stripe.Checkout.SessionCreateParams["discounts"] = undefined;
    const { data: discount } = await supabase
      .from("user_discounts")
      .select("discount_percent, months_remaining, stripe_coupon_id")
      .eq("user_id", user.id)
      .eq("is_active", true)
      .gt("months_remaining", 0)
      .maybeSingle();

    if (discount) {
      let couponId = discount.stripe_coupon_id;
      
      if (!couponId) {
        // Create a Stripe coupon and store it for reuse
        const coupon = await stripe.coupons.create({
          percent_off: discount.discount_percent,
          duration: "repeating",
          duration_in_months: discount.months_remaining,
          currency: "eur",
        });
        couponId = coupon.id;
        
        // Save the coupon ID for future use
        await supabase
          .from("user_discounts")
          .update({ stripe_coupon_id: couponId })
          .eq("user_id", user.id)
          .eq("is_active", true);
        
        logStep("Stripe coupon created and stored", { couponId });
      } else {
        logStep("Using stored Stripe coupon", { couponId });
      }
      
      discounts = [{ coupon: couponId }];
    }

    // Allow Stripe Promotion Codes at checkout
    const allowPromotionCodes = !discounts;

    // Determine redirect URLs
    const successPath = type === "trainer" ? "/app/trainer/subscription" 
      : type === "club" ? "/app/club/subscription" 
      : "/app/academy/subscription";

    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      mode: "subscription",
      success_url: `${origin}${successPath}?success=true&plan=${tier}`,
      cancel_url: `${origin}${successPath}?canceled=true`,
      metadata: {
        profile_id: profile.id,
        type,
        tier,
        user_id: user.id,
      },
    };

    // Either apply a specific discount or allow promo codes
    if (discounts) {
      sessionParams.discounts = discounts;
    } else {
      sessionParams.allow_promotion_codes = true;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    logStep("Checkout session created", { sessionId: session.id });

    // Update status to pending
    await supabase.from(table).update({
      subscription_status: "pending",
      subscription_tier: tier,
    }).eq("id", profile.id);

    return new Response(
      JSON.stringify({ checkoutUrl: session.url }),
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
