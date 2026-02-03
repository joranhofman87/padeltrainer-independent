import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: any) => {
  console.log(`[CREATE-CLUB-CHECKOUT] ${step}`, details ? JSON.stringify(details) : "");
};

// Club plan price ID - annual only at €2388/year (€199/month equivalent)
const CLUB_PRICE_ID = "price_1SqSZBPxAlHS6UZHJHw1xUFB";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) {
      throw new Error("Stripe secret key not configured");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error("Supabase configuration missing");
    }

    logStep("Authenticating user");
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      throw new Error("No authorization header");
    }

    const supabaseClient = createClient(supabaseUrl, supabaseServiceKey);
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser(token);
    
    if (authError || !user) {
      throw new Error("Invalid authentication");
    }
    logStep("User authenticated", { email: user.email });

    const { clubProfileId } = await req.json();
    if (!clubProfileId) {
      throw new Error("Club profile ID required");
    }

    // Verify user is a club manager
    const { data: clubProfile, error: clubError } = await supabaseClient
      .from("club_profiles")
      .select("*, club_managers!inner(user_id)")
      .eq("id", clubProfileId)
      .eq("club_managers.user_id", user.id)
      .maybeSingle();

    if (clubError || !clubProfile) {
      throw new Error("Club not found or access denied");
    }
    logStep("Club verified", { clubProfileId });

    const stripe = new Stripe(stripeKey, { apiVersion: "2023-10-16" });
    const origin = req.headers.get("origin") || "https://app.padeltrainer.ai";

    // Check for existing Mollie customer
    let customerId = clubProfile.mollie_customer_id;
    
    if (!customerId) {
      // Check if customer exists by email
      const existingCustomers = await stripe.customers.list({
        email: user.email,
        limit: 1,
      });

      if (existingCustomers.data.length > 0) {
        customerId = existingCustomers.data[0].id;
      } else {
        // Create new customer
        const customer = await stripe.customers.create({
          email: user.email,
          metadata: {
            club_profile_id: clubProfileId,
            user_id: user.id,
          },
        });
        customerId = customer.id;
      }

      // Save customer ID to club profile
      await supabaseClient
        .from("club_profiles")
        .update({ mollie_customer_id: customerId })
        .eq("id", clubProfileId);

      logStep("Customer created/found", { customerId });
    }

    // Check for existing active subscription
    const existingSubscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: "active",
      limit: 1,
    });

    if (existingSubscriptions.data.length > 0) {
      // Redirect to billing portal instead
      const portalSession = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${origin}/club/subscription`,
      });
      logStep("Existing subscription found, redirecting to portal");
      return new Response(JSON.stringify({ url: portalSession.url }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create checkout session with 14-day trial
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ["card", "ideal"],
      line_items: [
        {
          price: CLUB_PRICE_ID,
          quantity: 1,
        },
      ],
      mode: "subscription",
      subscription_data: {
        trial_period_days: 14,
        metadata: {
          club_profile_id: clubProfileId,
        },
      },
      success_url: `${origin}/club/subscription?success=true`,
      cancel_url: `${origin}/club/subscription?canceled=true`,
      metadata: {
        club_profile_id: clubProfileId,
      },
    });

    logStep("Checkout session created", { sessionId: session.id });

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("Error in create-club-checkout:", errorMessage);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
