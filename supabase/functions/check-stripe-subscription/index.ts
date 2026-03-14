import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[CHECK-STRIPE-SUBSCRIPTION] ${step}`, details ? JSON.stringify(details) : "");
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
    let trialEndsAt: string | null = null;

    if (type === "trainer") {
      const { data, error } = await supabase
        .from("trainer_profiles")
        .select("id, stripe_customer_id, subscription_status, subscription_tier, subscription_id, subscription_ends_at, trial_ends_at, is_public")
        .eq("user_id", user.id)
        .single();
      if (error || !data) throw new Error("Trainer profile not found");
      profile = data;
      trialEndsAt = data.trial_ends_at;
    } else if (type === "academy") {
      if (!profileId) throw new Error("Academy profile ID required");
      const { data, error } = await supabase
        .from("academy_profiles")
        .select("id, stripe_customer_id, subscription_status, subscription_tier, subscription_id, subscription_ends_at, trial_ends_at, academy_managers!inner(user_id)")
        .eq("id", profileId)
        .eq("academy_managers.user_id", user.id)
        .single();
      if (error || !data) throw new Error("Academy profile not found or access denied");
      profile = data;
      trialEndsAt = data.trial_ends_at;
    } else if (type === "club") {
      if (!profileId) throw new Error("Club profile ID required");
      const { data, error } = await supabase
        .from("club_profiles")
        .select("id, stripe_customer_id, subscription_status, subscription_tier, subscription_id, subscription_ends_at, trial_ends_at, club_managers!inner(user_id)")
        .eq("id", profileId)
        .eq("club_managers.user_id", user.id)
        .single();
      if (error || !data) throw new Error("Club profile not found or access denied");
      profile = data;
      trialEndsAt = data.trial_ends_at;
    } else {
      throw new Error("Invalid type. Use 'trainer', 'academy', or 'club'");
    }

    // Check manual admin override (active status without a Stripe customer)
    if (profile.subscription_status === "active" && !profile.stripe_customer_id) {
      logStep("Manual subscription override detected");
      return new Response(
        JSON.stringify({
          subscribed: true,
          status: "active",
          tier: profile.subscription_tier || "professional",
          endsAt: profile.subscription_ends_at,
          isManualOverride: true,
          ...(type === "trainer" && { isPublic: profile.is_public ?? false }),
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check trial status
    if (trialEndsAt) {
      const trialEnd = new Date(trialEndsAt);
      if (trialEnd > new Date()) {
        logStep(`${type} is in trial period`);
        return new Response(
          JSON.stringify({
            subscribed: true,
            status: "trialing",
            tier: type === "trainer" ? "trial" : type === "academy" ? "academy" : "club",
            trialEndsAt,
            ...(type === "trainer" && { isPublic: profile.is_public ?? false }),
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    if (!profile.stripe_customer_id) {
      logStep("No Stripe customer found");
      return new Response(
        JSON.stringify({ subscribed: false, status: "none" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Query Stripe for active subscriptions
    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });

    const subscriptions = await stripe.subscriptions.list({
      customer: profile.stripe_customer_id,
      status: "active",
      limit: 1,
    });

    if (subscriptions.data.length > 0) {
      const sub = subscriptions.data[0];
      const endsAt = new Date(sub.current_period_end * 1000).toISOString();

      // Sync DB if needed
      const table = type === "trainer" ? "trainer_profiles" : type === "academy" ? "academy_profiles" : "club_profiles";
      if (profile.subscription_status !== "active" || profile.subscription_id !== sub.id) {
        await supabase.from(table).update({
          subscription_status: "active",
          subscription_id: sub.id,
          subscription_ends_at: endsAt,
        }).eq("id", profile.id);
      }

      return new Response(
        JSON.stringify({
          subscribed: true,
          status: "active",
          tier: profile.subscription_tier || (type === "trainer" ? "professional" : type),
          endsAt,
          ...(type === "trainer" && { isPublic: profile.is_public ?? false }),
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check for canceled but still active subscriptions
    const canceledSubs = await stripe.subscriptions.list({
      customer: profile.stripe_customer_id,
      status: "canceled",
      limit: 1,
    });

    // Also check past_due
    const pastDueSubs = await stripe.subscriptions.list({
      customer: profile.stripe_customer_id,
      status: "past_due",
      limit: 1,
    });

    if (pastDueSubs.data.length > 0) {
      const sub = pastDueSubs.data[0];
      return new Response(
        JSON.stringify({
          subscribed: true,
          status: "past_due",
          tier: profile.subscription_tier,
          endsAt: new Date(sub.current_period_end * 1000).toISOString(),
          ...(type === "trainer" && { isPublic: profile.is_public ?? false }),
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check if there's a subscription that's been canceled but still within the period
    if (profile.subscription_ends_at) {
      const endsAt = new Date(profile.subscription_ends_at);
      if (endsAt > new Date()) {
        return new Response(
          JSON.stringify({
            subscribed: true,
            status: "canceled",
            tier: profile.subscription_tier,
            endsAt: profile.subscription_ends_at,
            ...(type === "trainer" && { isPublic: profile.is_public ?? false }),
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // No active subscription
    const table = type === "trainer" ? "trainer_profiles" : type === "academy" ? "academy_profiles" : "club_profiles";
    await supabase.from(table).update({ subscription_status: "inactive" }).eq("id", profile.id);

    return new Response(
      JSON.stringify({ subscribed: false, status: "inactive" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message });
    return new Response(
      JSON.stringify({ error: message, subscribed: false }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
