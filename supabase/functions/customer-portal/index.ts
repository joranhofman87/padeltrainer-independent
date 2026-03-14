import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[CUSTOMER-PORTAL] ${step}`, details ? JSON.stringify(details) : "");
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

    const { type = "trainer", profileId } = await req.json();

    let stripeCustomerId: string | null = null;

    if (type === "trainer") {
      const { data } = await supabase
        .from("trainer_profiles")
        .select("stripe_customer_id")
        .eq("user_id", user.id)
        .single();
      stripeCustomerId = data?.stripe_customer_id;
    } else if (type === "academy") {
      if (!profileId) throw new Error("Academy profile ID required");
      const { data } = await supabase
        .from("academy_profiles")
        .select("stripe_customer_id, academy_managers!inner(user_id)")
        .eq("id", profileId)
        .eq("academy_managers.user_id", user.id)
        .single();
      stripeCustomerId = data?.stripe_customer_id;
    } else if (type === "club") {
      if (!profileId) throw new Error("Club profile ID required");
      const { data } = await supabase
        .from("club_profiles")
        .select("stripe_customer_id, club_managers!inner(user_id)")
        .eq("id", profileId)
        .eq("club_managers.user_id", user.id)
        .single();
      stripeCustomerId = data?.stripe_customer_id;
    }

    if (!stripeCustomerId) {
      throw new Error("No Stripe customer found. Please subscribe first.");
    }

    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });
    const origin = req.headers.get("origin") || "https://padeltrainer.ai";

    const returnPath = type === "trainer" ? "/app/trainer/subscription"
      : type === "club" ? "/app/club/subscription"
      : "/app/academy/subscription";

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: `${origin}${returnPath}`,
    });

    logStep("Portal session created", { url: portalSession.url });

    return new Response(
      JSON.stringify({ url: portalSession.url }),
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
