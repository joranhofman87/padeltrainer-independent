import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: any) => {
  console.log(`[CHECK-CLUB-SUBSCRIPTION] ${step}`, details ? JSON.stringify(details) : "");
};

// Club plan product ID
const CLUB_PRODUCT_ID = "prod_TobiJfC96Jjf3h";

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

    // Verify user is a club manager and get club profile
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

    // Default response
    let response: {
      isSubscribed: boolean;
      isTrial: boolean;
      tier: string;
      subscriptionEnd: string | null;
      trialEnd: string | null;
      trialExpired: boolean;
    } = {
      isSubscribed: false,
      isTrial: true,
      tier: "starter",
      subscriptionEnd: null,
      trialEnd: clubProfile.trial_ends_at,
      trialExpired: clubProfile.trial_ends_at ? new Date(clubProfile.trial_ends_at) < new Date() : false,
    };

    // Check Stripe subscription if customer exists
    if (clubProfile.stripe_customer_id) {
      const subscriptions = await stripe.subscriptions.list({
        customer: clubProfile.stripe_customer_id,
        limit: 1,
      });

      if (subscriptions.data.length > 0) {
        const subscription = subscriptions.data[0];
        const productId = subscription.items.data[0]?.price?.product;

        if (productId === CLUB_PRODUCT_ID) {
          response = {
            isSubscribed: subscription.status === "active" || subscription.status === "trialing",
            isTrial: subscription.status === "trialing",
            tier: "club",
            subscriptionEnd: subscription.current_period_end
              ? new Date(subscription.current_period_end * 1000).toISOString()
              : null,
            trialEnd: subscription.trial_end
              ? new Date(subscription.trial_end * 1000).toISOString()
              : clubProfile.trial_ends_at,
            trialExpired: false,
          };

          // Update club profile with subscription status
          await supabaseClient
            .from("club_profiles")
            .update({
              subscription_status: subscription.status === "trialing" ? "trial" : 
                                   subscription.status === "active" ? "active" : "expired",
              subscription_tier: "club",
              subscription_id: subscription.id,
              subscription_ends_at: response.subscriptionEnd,
              trial_ends_at: response.trialEnd,
            })
            .eq("id", clubProfileId);

          logStep("Subscription found and updated", { status: subscription.status });
        }
      }
    }

    logStep("Returning subscription status", response);
    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("Error in check-club-subscription:", errorMessage);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
