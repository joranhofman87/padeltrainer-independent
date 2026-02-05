import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  console.log(`[CHECK-MOLLIE-SUBSCRIPTION] ${step}`, details ? JSON.stringify(details) : "");
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
    logStep("User authenticated", { userId: user.id });

    const { type = "trainer", profileId } = await req.json();

    let profile;
    let customerId: string | null = null;

    let trialEndsAt: string | null = null;

    if (type === "trainer") {
      const { data, error } = await supabase
        .from("trainer_profiles")
        .select("id, mollie_customer_id, subscription_status, subscription_tier, subscription_id, subscription_ends_at, trial_ends_at")
        .eq("user_id", user.id)
        .single();

      if (error || !data) throw new Error("Trainer profile not found");
      profile = data;
      customerId = data.mollie_customer_id;
      trialEndsAt = data.trial_ends_at;
    } else if (type === "academy") {
      if (!profileId) throw new Error("Academy profile ID required");
      
      const { data, error } = await supabase
        .from("academy_profiles")
        .select("id, mollie_customer_id, subscription_status, subscription_tier, subscription_id, subscription_ends_at, trial_ends_at, academy_managers!inner(user_id)")
        .eq("id", profileId)
        .eq("academy_managers.user_id", user.id)
        .single();

      if (error || !data) throw new Error("Academy profile not found or access denied");
      profile = data;
      customerId = data.mollie_customer_id;
      trialEndsAt = data.trial_ends_at;
    } else if (type === "club") {
      if (!profileId) throw new Error("Club profile ID required");
      
      const { data, error } = await supabase
        .from("club_profiles")
        .select("id, mollie_customer_id, subscription_status, subscription_tier, subscription_id, subscription_ends_at, trial_ends_at, club_managers!inner(user_id)")
        .eq("id", profileId)
        .eq("club_managers.user_id", user.id)
        .single();

      if (error || !data) throw new Error("Club profile not found or access denied");
      profile = data;
      customerId = data.mollie_customer_id;
      trialEndsAt = data.trial_ends_at;
    } else {
      throw new Error("Invalid type. Use 'trainer', 'academy', or 'club'");
    }

    // Check if manually set to active (admin override)
    if (profile.subscription_status === "active" && !customerId) {
      logStep("Manual subscription override detected");
      return new Response(
        JSON.stringify({
          subscribed: true,
          status: "active",
          tier: profile.subscription_tier || "professional",
          endsAt: profile.subscription_ends_at,
          isManualOverride: true,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check trial status for all profile types
    if (trialEndsAt) {
      const trialEnd = new Date(trialEndsAt);
      if (trialEnd > new Date()) {
        logStep(`${type} is in trial period`);
        return new Response(
          JSON.stringify({
            subscribed: true,
            status: "trialing",
            tier: type === "trainer" ? "trial" : type === "academy" ? "academy" : "club",
            trialEndsAt: trialEndsAt,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    if (!customerId) {
      logStep("No Mollie customer found");
      return new Response(
        JSON.stringify({ subscribed: false, status: "none" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch subscriptions from Mollie
    const subsResponse = await fetch(
      `https://api.mollie.com/v2/customers/${customerId}/subscriptions`,
      {
        headers: { "Authorization": `Bearer ${mollieApiKey}` },
      }
    );

    if (!subsResponse.ok) {
      logStep("Failed to fetch subscriptions from Mollie");
      // Fall back to database status
      return new Response(
        JSON.stringify({
          subscribed: profile.subscription_status === "active",
          status: profile.subscription_status || "none",
          tier: profile.subscription_tier,
          endsAt: profile.subscription_ends_at,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const subscriptions = await subsResponse.json();
    logStep("Subscriptions fetched", { count: subscriptions.count });

    // Find active subscription
    const activeSubscription = subscriptions._embedded?.subscriptions?.find(
      (sub: { status: string }) => sub.status === "active"
    );

    if (activeSubscription) {
      // Update database if needed
      if (profile.subscription_status !== "active" || profile.subscription_id !== activeSubscription.id) {
        const table = type === "trainer" ? "trainer_profiles" : type === "academy" ? "academy_profiles" : "club_profiles";
        await supabase
          .from(table)
          .update({
            subscription_status: "active",
            subscription_id: activeSubscription.id,
          })
          .eq("id", profile.id);
      }

      return new Response(
        JSON.stringify({
          subscribed: true,
          status: "active",
          tier: profile.subscription_tier || (type === "trainer" ? "professional" : type === "academy" ? "academy" : "club"),
          subscriptionId: activeSubscription.id,
          nextPaymentDate: activeSubscription.nextPaymentDate,
          amount: activeSubscription.amount,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check for canceled subscription with remaining time
    const canceledSubscription = subscriptions._embedded?.subscriptions?.find(
      (sub: { status: string; canceledAt: string }) => sub.status === "canceled" && sub.canceledAt
    );

    if (canceledSubscription && profile.subscription_ends_at) {
      const endsAt = new Date(profile.subscription_ends_at);
      if (endsAt > new Date()) {
        return new Response(
          JSON.stringify({
            subscribed: true,
            status: "canceled",
            tier: profile.subscription_tier,
            endsAt: profile.subscription_ends_at,
            canceledAt: canceledSubscription.canceledAt,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // No active subscription
    const table = type === "trainer" ? "trainer_profiles" : type === "academy" ? "academy_profiles" : "club_profiles";
    await supabase
      .from(table)
      .update({ subscription_status: "inactive" })
      .eq("id", profile.id);

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
