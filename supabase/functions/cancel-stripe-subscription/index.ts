import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[CANCEL-STRIPE-SUBSCRIPTION] ${step}`, details ? JSON.stringify(details) : "");
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
    logStep("User authenticated", { userId: user.id });

    const { type = "trainer", profileId } = await req.json();

    let profile: any;
    let table: string;

    if (type === "trainer") {
      table = "trainer_profiles";
      const { data, error } = await supabase
        .from("trainer_profiles")
        .select("id, stripe_customer_id, subscription_id, subscription_ends_at")
        .eq("user_id", user.id)
        .single();
      if (error || !data) throw new Error("Trainer profile not found");
      profile = data;
    } else if (type === "academy") {
      table = "academy_profiles";
      if (!profileId) throw new Error("Academy profile ID required");
      const { data, error } = await supabase
        .from("academy_profiles")
        .select("id, stripe_customer_id, subscription_id, subscription_ends_at, academy_managers!inner(user_id)")
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
        .select("id, stripe_customer_id, subscription_id, subscription_ends_at, club_managers!inner(user_id)")
        .eq("id", profileId)
        .eq("club_managers.user_id", user.id)
        .single();
      if (error || !data) throw new Error("Club profile not found or access denied");
      profile = data;
    } else {
      throw new Error("Invalid type. Use 'trainer', 'academy', or 'club'");
    }

    if (!profile.subscription_id) {
      throw new Error("No active subscription found");
    }

    logStep("Canceling subscription", { subscriptionId: profile.subscription_id });

    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });

    // Cancel at period end (not immediately)
    const subscription = await stripe.subscriptions.update(profile.subscription_id, {
      cancel_at_period_end: true,
    });

    const endsAt = new Date(subscription.current_period_end * 1000).toISOString();

    // Update database
    await supabase.from(table).update({
      subscription_status: "canceled",
      subscription_ends_at: endsAt,
    }).eq("id", profile.id);

    logStep("Subscription canceled at period end", { endsAt });

    return new Response(
      JSON.stringify({
        success: true,
        message: "Subscription canceled. Access continues until the end of the billing period.",
        endsAt,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message });
    return new Response(
      JSON.stringify({ error: message, success: false }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
