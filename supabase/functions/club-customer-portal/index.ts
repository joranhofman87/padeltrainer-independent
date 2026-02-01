import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: any) => {
  console.log(`[CLUB-CUSTOMER-PORTAL] ${step}`, details ? JSON.stringify(details) : "");
};

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
      .select("stripe_customer_id, club_managers!inner(user_id)")
      .eq("id", clubProfileId)
      .eq("club_managers.user_id", user.id)
      .maybeSingle();

    if (clubError || !clubProfile) {
      throw new Error("Club not found or access denied");
    }

    if (!clubProfile.stripe_customer_id) {
      throw new Error("No billing account found. Please subscribe first.");
    }

    logStep("Club verified", { clubProfileId, customerId: clubProfile.stripe_customer_id });

    const stripe = new Stripe(stripeKey, { apiVersion: "2023-10-16" });
    const origin = req.headers.get("origin") || "https://app.padeltrainer.ai";

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: clubProfile.stripe_customer_id,
      return_url: `${origin}/club/subscription`,
    });

    logStep("Portal session created");

    return new Response(JSON.stringify({ url: portalSession.url }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("Error in club-customer-portal:", errorMessage);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
